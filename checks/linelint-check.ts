import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck, CheckResult } from "./base-check.js";
import fs from "fs/promises";
import { getLinelintPath } from "../tool-resolve/linelint.js";

const execFileAsync = promisify(execFile);

export class LinelintCheck extends BaseCheck {
  constructor(repoRoot: string, options: any = {}) {
    super(repoRoot, options);
  }

  override get name(): string {
    return "Linelint";
  }

  override async resolveDeps(options: any): Promise<any> {
    const linelintPath = await getLinelintPath(options);
    return { linelintPath };
  }

  override checkDeps(deps: any): boolean {
    return deps.linelintPath !== undefined;
  }

  override async lint(file: string, deps: any): Promise<CheckResult> {
    try {
      await execFileAsync(deps.linelintPath, [file], { cwd: this.repoRoot });
      return { status: "pass" };
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { status: "error", output: err.message };
      }
      const out = (err.stderr || err.stdout || "").toString().trim();
      return { status: "fail", output: out || "linelint failed" };
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
      await execFileAsync(deps.linelintPath, ["-a", file], { cwd: this.repoRoot });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { status: "error", output: err.message };
      }
      const out = (err.stderr || err.stdout || "").toString().trim();
      return { status: "error", output: out || "linelint fix failed" };
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
      name: "LinelintCheck",
      description: "Runs linelint to enforce final-newline and trailing-whitespace rules. Auto-downloads the binary if needed.",
      options: "(uses linelint config from repo root)",
    };
  }
}
