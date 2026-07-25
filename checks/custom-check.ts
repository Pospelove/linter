import fs from "fs/promises";
import { spawn } from "child_process";
import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * Custom check — delegates lint and fix to user-provided CLI commands.
 *
 * The command is run in a shell (sh on Unix, cmd on Windows) with the
 * repo root for the working directory. Details about the current file and
 * run mode are communicated via environment variables:
 *
 *   LINTER_FILE              — absolute path to the file being checked
 *   LINTER_REPO_ROOT         — absolute path to the repo root
 *   LINTER_MODE              — "lint" or "fix"
 *
 * Exit-code protocol
 *   lint:  0 = pass  |  1 = fail  |  other = error
 *   fix:   0 = fixed/pass (compared by reading the file before and after)
 *          other = error
 *
 * stdout and stderr are concatenated and surfaced for the diagnostic output
 * on fail or error.
 *
 * Options (from linter-config.json):
 *   command      — command for both lint and fix (required unless both
 *                  lintCommand and fixCommand are set)
 *   lintCommand  — command for lint mode (overrides command)
 *   fixCommand   — command for fix mode (overrides command)
 *   name         — human-readable check name (default: derived from command)
 *
 * Example:
 *   {
 *     "export": "CustomCheck",
 *     "options": {
 *       "name": "My style check",
 *       "lintCommand": "python scripts/style.py --check",
 *       "fixCommand":  "python scripts/style.py --fix",
 *       "extensions":  [".py"]
 *     }
 *   }
 */
export class CustomCheck extends BaseCheck {
  #lintCommand: string | null;
  #fixCommand: string | null;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);

    const base = typeof options["command"] === "string" ? options["command"] : null;
    this.#lintCommand = typeof options["lintCommand"] === "string" ? options["lintCommand"] : base;
    this.#fixCommand = typeof options["fixCommand"] === "string" ? options["fixCommand"] : base;

    if (!this.#lintCommand) {
      throw new Error("CustomCheck requires options.command or options.lintCommand");
    }

    const name = typeof options["name"] === "string" ? options["name"] : null;
    this.name = name || `Custom (${this.#lintCommand})`;
  }

  override async lint(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const env = this.#buildEnv(file, "lint");
    const { code, stdout, stderr, output } = await this.#run(this.#lintCommand!, env);

    if (code === 0) return { status: "pass" };

    // Try to parse stdout as a JSON array of findings or a CheckResult object.
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        const result: CheckResult = { status: "fail", findings: parsed };
        if (stderr) {
          result.output = stderr;
        }
        return result;
      }
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.findings)) {
        return { status: "fail", ...parsed };
      }
    } catch {
      // Not JSON, fall back to legacy behavior.
    }

    if (code === 1) return { status: "fail", output };
    return { status: "error", output };
  }

  override async fix(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    if (!this.#fixCommand) {
      return { status: "error", output: "CustomCheck: no fixCommand configured" };
    }

    let before: Buffer;
    try {
      before = await fs.readFile(file);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", output: `cannot read file before fix: ${message}` };
    }

    const env = this.#buildEnv(file, "fix");
    const { code, output } = await this.#run(this.#fixCommand, env);

    if (code !== 0) return { status: "error", output };

    let after: Buffer;
    try {
      after = await fs.readFile(file);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", output: `cannot read file after fix: ${message}` };
    }

    return before.equals(after) ? { status: "pass" } : { status: "fixed" };
  }

  #buildEnv(file: string, mode: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      LINTER_FILE: file,
      LINTER_REPO_ROOT: this.repoRoot,
      LINTER_MODE: mode,
    };
  }

  /** Run a shell command, capturing stdout+stderr, resolving to { code, stdout, stderr, output }. */
  #run(
    command: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ code: number; stdout: string; stderr: string; output: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, [], {
        shell: true,
        cwd: this.repoRoot,
        env,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
      proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

      proc.on("close", (code: number | null) => {
        const stdout = Buffer.concat(stdoutChunks).toString().trim();
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({ code: code ?? 1, stdout, stderr, output });
      });

      proc.on("error", (err: Error) => {
        resolve({ code: -1, stdout: "", stderr: err.message, output: err.message });
      });
    });
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "CustomCheck",
      description:
        "Delegates lint and fix to user-provided shell commands. " +
        "File details are passed via environment variables " +
        "(LINTER_FILE, LINTER_REPO_ROOT, LINTER_MODE). " +
        "Exit codes: lint 0=pass, 1=fail, other=error; fix 0=pass/fixed (auto-detected), other=error. " +
        "On fail (exit 1), if stdout is a JSON array of findings, it is used for per-finding reporting.",
      options:
        "command — shell command for both modes; " +
        "lintCommand — overrides command for lint; " +
        "fixCommand — overrides command for fix; " +
        "name — display name for the check",
    };
  }
}
