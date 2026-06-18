import { promises as fs } from "fs";
import { spawn } from "child_process";
import { BaseCheck } from "./base-check.js";

/**
 * Custom check — delegates lint and fix to user-provided CLI commands.
 *
 * The command is run in a shell (sh on Unix, cmd on Windows) with the
 * repo root as the working directory. Details about the current file and
 * run mode are communicated via environment variables:
 *
 *   LINTER_FILE              — absolute path to the file being checked
 *   LINTER_REPO_ROOT         — absolute path to the repo root
 *   LINTER_MODE              — "lint" or "fix"
 *   LINTER_ENTRY_ID          — entry identifier (e.g. "data.json[3]")
 *   LINTER_ENTRY_SOURCE_FILE — real file on disk (differs from LINTER_FILE
 *                              when a virtual entry/expander is in use)
 *   LINTER_ENTRY_METADATA    — JSON-serialised entry.metadata object
 *
 * Exit-code protocol
 *   lint:  0 = pass  |  1 = fail  |  other = error
 *   fix:   0 = fixed/pass (compared by reading the file before and after)
 *          other = error
 *
 * stdout and stderr are concatenated and surfaced as the diagnostic output
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
  #name;
  #lintCommand;
  #fixCommand;

  constructor(repoRoot, options = {}) {
    super(repoRoot, options);

    const base = options.command ?? null;
    this.#lintCommand = options.lintCommand ?? base;
    this.#fixCommand = options.fixCommand ?? base;

    if (!this.#lintCommand) {
      throw new Error("CustomCheck requires options.command or options.lintCommand");
    }

    this.#name = options.name ?? `Custom (${this.#lintCommand})`;
  }

  get name() {
    return this.#name;
  }

  async lint(file, _deps, entry = null) {
    const env = this.#buildEnv(file, "lint", entry);
    const { code, output } = await this.#run(this.#lintCommand, env);

    if (code === 0) return { status: "pass" };
    if (code === 1) return { status: "fail", output };
    return { status: "error", output };
  }

  async fix(file, _deps, entry = null) {
    if (!this.#fixCommand) {
      return { status: "error", output: "CustomCheck: no fixCommand configured" };
    }

    let before;
    try {
      before = await fs.readFile(file);
    } catch (err) {
      return { status: "error", output: `cannot read file before fix: ${err.message}` };
    }

    const env = this.#buildEnv(file, "fix", entry);
    const { code, output } = await this.#run(this.#fixCommand, env);

    if (code !== 0) return { status: "error", output };

    let after;
    try {
      after = await fs.readFile(file);
    } catch (err) {
      return { status: "error", output: `cannot read file after fix: ${err.message}` };
    }

    return before.equals(after) ? { status: "pass" } : { status: "fixed" };
  }

  #buildEnv(file, mode, entry) {
    return {
      ...process.env,
      LINTER_FILE: file,
      LINTER_REPO_ROOT: this.repoRoot,
      LINTER_MODE: mode,
      LINTER_ENTRY_ID: entry?.id ?? file,
      LINTER_ENTRY_SOURCE_FILE: entry?.sourceFile ?? file,
      LINTER_ENTRY_METADATA: JSON.stringify(entry?.metadata ?? {}),
    };
  }

  /** Run a shell command, capturing stdout+stderr, resolving to { code, output }. */
  #run(command, env) {
    return new Promise((resolve) => {
      const proc = spawn(command, [], {
        shell: true,
        cwd: this.repoRoot,
        env,
      });

      const chunks = [];
      proc.stdout.on("data", (d) => chunks.push(d));
      proc.stderr.on("data", (d) => chunks.push(d));

      proc.on("close", (code) => {
        const output = Buffer.concat(chunks).toString().trim();
        resolve({ code: code ?? 1, output });
      });

      proc.on("error", (err) => {
        resolve({ code: -1, output: err.message });
      });
    });
  }

  static getHelp() {
    return {
      name: "CustomCheck",
      description:
        "Delegates lint and fix to user-provided shell commands. " +
        "File details are passed via environment variables " +
        "(LINTER_FILE, LINTER_REPO_ROOT, LINTER_MODE, LINTER_ENTRY_ID, " +
        "LINTER_ENTRY_SOURCE_FILE, LINTER_ENTRY_METADATA). " +
        "Exit codes: lint 0=pass, 1=fail, other=error; fix 0=pass/fixed (auto-detected), other=error.",
      options:
        "command — shell command for both modes; " +
        "lintCommand — overrides command for lint; " +
        "fixCommand — overrides command for fix; " +
        "name — display name for the check",
    };
  }
}
