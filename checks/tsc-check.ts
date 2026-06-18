import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck } from "./base-check.js";
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
  #tsconfigPath;
  /** @type {{ re: RegExp, message: string }[]} */
  #errorMessages;
  /** @type {Promise<Map<string, string[]>> | null} */
  #resultPromise = null;

  constructor(repoRoot, options = {}) {
    super(repoRoot, options);
    this.#tsconfigPath = options.tsconfigPath ?? "tsconfig.json";
    this.#errorMessages = (options.errorMessages || []).map((e) => ({
      re: new RegExp(e.pattern),
      message: e.message,
    }));
  }

  get name() {
    return "TypeScript";
  }

  async resolveDeps({ shouldSearchInPath }) {
    let tscPath;
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
    return { tscPath };
  }

  checkDeps(deps) {
    return deps.tscPath !== undefined;
  }

  /**
   * Run tsc once and return a Map<absolutePath, diagnosticLines[]>.
   * The promise is shared so concurrent lint() calls wait on the same run.
   */
  #runTsc(deps) {
    if (!this.#resultPromise) {
      this.#resultPromise = (async () => {
        /** @type {Map<string, string[]>} */
        const errors = new Map();

        const args = ["--noEmit", "--pretty", "false", "-p", path.resolve(this.repoRoot, this.#tsconfigPath)];

        try {
          await execFileAsync(deps.tscPath, args, {
            cwd: this.repoRoot,
            maxBuffer: 10 * 1024 * 1024,
            shell: process.platform === "win32",
          });
        } catch (err) {
          if (err.code === "ENOENT") {
            errors.set("__global__", [`tsc not found: ${err.message}`]);
            return errors;
          }
          const output = (err.stdout || err.stderr || "").toString();
          // Parse tsc output lines like:  src/foo.ts(10,5): error TS2322: ...
          for (const line of output.split("\n")) {
            const match = line.match(/^(.+?)\(\d+,\d+\):\s*error\s+TS\d+:/);
            if (match) {
              const absFile = path.resolve(this.repoRoot, match[1]);
              if (!errors.has(absFile)) errors.set(absFile, []);
              errors.get(absFile).push(this.#annotate(line));
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
  #annotate(line) {
    for (const { re, message } of this.#errorMessages) {
      if (re.test(line)) {
        return `${line}\n  >>> ${message}`;
      }
    }
    return line;
  }

  async lint(file, deps) {
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

  async fix(file, deps) {
    // No autofix for TypeScript type errors
    return this.lint(file, deps);
  }

  static getHelp() {
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
