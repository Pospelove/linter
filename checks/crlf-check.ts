import fs from "fs/promises";
import { BaseCheck, CheckResult } from "./base-check.js";

export class CrlfCheck extends BaseCheck {
  constructor(repoRoot: string, options: any = {}) {
    super(repoRoot, options);
  }

  override get name(): string {
    return "CRLF";
  }

  override async lint(file: string, _deps: any): Promise<CheckResult> {
    try {
      const content = await fs.readFile(file);
      if (content.includes("\r\n")) {
        return { status: "fail", output: "contains CRLF line endings" };
      }
      return { status: "pass" };
    } catch (err: any) {
      return { status: "error", output: err.message };
    }
  }

  override async fix(file: string, _deps: any): Promise<CheckResult> {
    try {
      const before = await fs.readFile(file);
      if (before.includes("\r\n")) {
        const fixed = before.toString("utf-8").replace(/\r\n/g, "\n");
        await fs.writeFile(file, Buffer.from(fixed, "utf-8"));
        return { status: "fixed" };
      }
      return { status: "pass" };
    } catch (err: any) {
      return { status: "error", output: err.message };
    }
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "CrlfCheck",
      description: "Detects and fixes CRLF (\\r\\n) line endings, replacing them with LF (\\n).",
      options: "extensions — file extensions to check (e.g. [\".cpp\", \".h\", \".js\"])",
    };
  }
}
