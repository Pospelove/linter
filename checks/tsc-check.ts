import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck, CheckResult } from "./base-check.js";
import { checkInPath } from "../tool-resolve/tool-utils.js";

const execFileAsync = promisify(execFile);

/**
 * TypeScript type-check — runs `tsc --noEmit` against the project and
 * reports per-file errors.  No autofix is available.
 *
 * Because tsc is a whole-project operation the check runs once on the
 * first lint() call and caches the parsed diagnostics.  Subsequent
 * per-file calls return the cached result for that file.
 *
 * Options (linter-config.json):
 *   tsconfigPath  — path to tsconfig.json relative to repo root
 *                   (default: "tsconfig.json")
 *   errorMessages — array of { pattern, message } objects.  When a tsc
 *                   diagnostic line matches `pattern` (regex string), the
 *                   custom `message` is appended after that line so that
 *                   coding agents get actionable guidance instead of raw
 *                   type errors.
 */
export class TscCheck extends BaseCheck {
  #tsconfigPath: string;
  #errorMessages: { re: RegExp; message: string }[];
  #resultPromise: Promise<Map<string, string[]>> | null = null;

  constructor(repoRoot: string, options: any = {}) {
    super(repoRoot, options);
    this.#tsconfigPath = options.tsconfigPath ?? "tsconfig.json";
    this.#errorMessages = (options.errorMessages || []).map((e: any) => ({
      re: new RegExp(e.pattern),
      message: e.message,
    }));
  }

  override get name(): string {
    return "TypeScript";
  }

  override async resolveDeps(options: { shouldSearchInPath: boolean }): Promise<any> {
    const { shouldSearchInPath } = options;
    let tscPath: string | null | undefined;
    if (shouldSearchInPath) {
      tscPath = checkInPath("tsc");
      // On Windows, `where tsc` may return the POSIX shebang script (no extension)
      // before tsc.cmd. execFile can't run that without shell:true, so append .cmd.
      if (tscPath && process.platform === "win32" && !tscPath.endsWith(".cmd") && !tscPath.endsWith(".exe")) {
        tscPath = tscPath + ".cmd";
      }
    }
    if (!tscPath) {
      // Try project-local npx tsc (node_modules/.bin)
      const localBin = path.resolve(this.repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      try {
        await execFileAsync(localBin, ["--version"], { shell: process.platform === "win32" });
        tscPath = localBin;
      } catch {
        // not available locally
      }
    }
    return { tscPath: tscPath ?? undefined };
  }

  override checkDeps(deps: any): boolean {
    return deps.tscPath !== undefined;
  }

  /**
   * Run tsc once and return a Map<absolutePath, diagnosticLines[]>.
   * The promise is shared so concurrent lint() calls wait on the same run.
   */
  #runTsc(deps: any): Promise<Map<string, string[]>> {
    if (!this.#resultPromise) {
      this.#resultPromise = (async () => {
        const errors = new Map<string, string[]>();

        const args = ["--noEmit", "--pretty", "false", "-p", path.resolve(this.repoRoot, this.#tsconfigPath)];

        try {
          await execFileAsync(deps.tscPath, args, {
            cwd: this.repoRoot,
            maxBuffer: 10 * 1024 * 1024,
            shell: process.platform === "win32",
          });
        } catch (err: any) {
          if (err.code === "ENOENT") {
            errors.set("__global__", [`tsc not found: ${err.message}`]);
            return errors;
          }
          const output: string = (err.stdout || err.stderr || "").toString();
          // Parse tsc output lines like:  src/foo.ts(10,5): error TS2322: ...
          for (const line of output.split("\n")) {
            const match = line.match(/^(.+?)\(\d+,\d+\):\s*error\s+TS\d+:/);
            if (match) {
              const absFile = path.resolve(this.repoRoot, match[1]!);
              if (!errors.has(absFile)) errors.set(absFile, []);
              errors.get(absFile)!.push(this.#annotate(line));
            }
          }
          // If we couldn't parse any per-file errors, report globally
          if (errors.size === 0 && output.trim()) {
            errors.set("__global__", [output.trim()]);
          }
        }
        return errors;
      })();
    }
    return this.#resultPromise;
  }

  /**
   * If the line matches any errorMessages pattern, append the custom message.
   */
  #annotate(line: string): string {
    for (const { re, message } of this.#errorMessages) {
      if (re.test(line)) {
        return `${line}\n  >>> ${message}`;
      }
    }
    return line;
  }

  override async lint(file: string, deps: any): Promise<CheckResult> {
    const errors = await this.#runTsc(deps);

    // Global (non-file) error
    const global = errors.get("__global__");
    if (global) {
      return { status: "error", output: global.join("\n") };
    }

    const abs = path.resolve(file);
    const fileErrors = errors.get(abs);
    if (fileErrors && fileErrors.length > 0) {
      return { status: "fail", output: fileErrors.join("\n") };
    }
    return { status: "pass" };
  }

  override async fix(file: string, deps: any): Promise<CheckResult> {
    // No autofix for TypeScript type errors
    return this.lint(file, deps);
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "TscCheck",
      description:
        "Runs tsc --noEmit to type-check the project. Reports per-file " +
        "TypeScript errors. No autofix available.",
      options:
        'tsconfigPath — path to tsconfig.json relative to repo root (default: "tsconfig.json")\n' +
        'errorMessages — array of { pattern, message }; when a tsc error matches the regex pattern, the custom message is appended',
    };
  }
}
