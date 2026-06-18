import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck, CheckResult } from "./base-check.js";
import { getClangFormatPath } from "../tool-resolve/clang-format.js";

const execFileAsync = promisify(execFile);

export class ClangFormatCheck extends BaseCheck {
  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
  }

  override get name(): string {
    return "Clang Format";
  }

  override async resolveDeps(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const clangFormatPath = await getClangFormatPath({
      shouldDownload: options["shouldDownload"] !== false,
      shouldSearchInPath: options["shouldSearchInPath"] !== false,
      toolsDir: typeof options["toolsDir"] === "string" ? options["toolsDir"] : ".linter/tools",
    });
    return { clangFormatPath };
  }

  override checkDeps(deps: Record<string, unknown>): boolean {
    return typeof deps["clangFormatPath"] === "string";
  }

  override async lint(file: string, deps: Record<string, unknown>): Promise<CheckResult> {
    const clangFormatPath = deps["clangFormatPath"];
    if (typeof clangFormatPath !== "string") {
      return { status: "error", output: "clangFormatPath dependency is missing or not a string" };
    }

    try {
      await execFileAsync(clangFormatPath, ["--dry-run", "--Werror", file]);
      return { status: "pass" };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        const message = "message" in err ? String(err.message) : "File not found";
        return { status: "error", output: message };
      }
      let stderr = "";
      let stdout = "";
      if (err && typeof err === "object") {
        if ("stderr" in err && (typeof err.stderr === "string" || Buffer.isBuffer(err.stderr))) {
          stderr = err.stderr.toString();
        }
        if ("stdout" in err && (typeof err.stdout === "string" || Buffer.isBuffer(err.stdout))) {
          stdout = err.stdout.toString();
        }
      }
      const output = (stderr || stdout || "").trim();
      return { status: "fail", output };
    }
  }

  override async fix(file: string, deps: Record<string, unknown>): Promise<CheckResult> {
    const clangFormatPath = deps["clangFormatPath"];
    if (typeof clangFormatPath !== "string") {
      return { status: "error", output: "clangFormatPath dependency is missing or not a string" };
    }

    let before: Buffer;
    try {
      before = await fs.readFile(file);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", output: message };
    }

    try {
      await execFileAsync(clangFormatPath, ["-i", file]);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        const message = "message" in err ? String(err.message) : "File not found";
        return { status: "error", output: message };
      }
      let stderr = "";
      let stdout = "";
      if (err && typeof err === "object") {
        if ("stderr" in err && (typeof err.stderr === "string" || Buffer.isBuffer(err.stderr))) {
          stderr = err.stderr.toString();
        }
        if ("stdout" in err && (typeof err.stdout === "string" || Buffer.isBuffer(err.stdout))) {
          stdout = err.stdout.toString();
        }
      }
      const output = (stderr || stdout || "").trim();
      return { status: "error", output };
    }

    try {
      const after = await fs.readFile(file);
      if (!before.equals(after)) {
        return { status: "fixed" };
      }
      return { status: "pass" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", output: message };
    }
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "ClangFormatCheck",
      description: "Runs clang-format on files. Auto-downloads the binary if needed.",
      options: "extensions — file extensions to format (e.g. [\".cpp\", \".h\"])",
    };
  }
}
