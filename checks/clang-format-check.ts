import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck, CheckResult } from "./base-check.js";
import { getClangFormatPath } from "../tool-resolve/clang-format.js";

const execFileAsync = promisify(execFile);

export class ClangFormatCheck extends BaseCheck {
  constructor(repoRoot: string, options: any = {}) {
    super(repoRoot, options);
  }

  override get name(): string {
    return "Clang Format";
  }

  override async resolveDeps(options: any): Promise<any> {
    const clangFormatPath = await getClangFormatPath(options);
    return { clangFormatPath };
  }

  override checkDeps(deps: any): boolean {
    return deps.clangFormatPath !== undefined;
  }

  override async lint(file: string, deps: any): Promise<CheckResult> {
    try {
      await execFileAsync(deps.clangFormatPath, ["--dry-run", "--Werror", file]);
      return { status: "pass" };
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { status: "error", output: err.message };
      }
      const output = (err.stderr || err.stdout || "").toString().trim();
      return { status: "fail", output };
    }
  }

  override async fix(file: string, deps: any): Promise<CheckResult> {
    let before: Buffer;
    try {
      before = await fs.readFile(file);
    } catch (err: any) {
      return { status: "error", output: err.message };
    }

    try {
      await execFileAsync(deps.clangFormatPath, ["-i", file]);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { status: "error", output: err.message };
      }
      const output = (err.stderr || err.stdout || "").toString().trim();
      return { status: "error", output };
    }

    try {
      const after = await fs.readFile(file);
      if (!before.equals(after)) {
        return { status: "fixed" };
      }
      return { status: "pass" };
    } catch (err: any) {
      return { status: "error", output: err.message };
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
