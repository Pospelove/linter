import fs from "fs/promises";
import { BaseCheck, CheckResult, CheckFinding } from "./base-check.js";

export class CrlfCheck extends BaseCheck {
  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    this.name = "CRLF";
  }

  override async lint(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    try {
      const content = await fs.readFile(file);
      if (content.includes("\r\n")) {
        const findings: CheckFinding[] = [];
        const text = content.toString("utf-8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.endsWith("\r")) {
            findings.push({
              message: "contains CRLF line ending",
              snippet: line.slice(0, -1),
              startLine: i + 1,
              endLine: i + 1,
            });
          }
        }
        return { status: "fail", output: "contains CRLF line endings", findings };
      }
      return { status: "pass" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", output: message };
    }
  }

  override async fix(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    try {
      const before = await fs.readFile(file);
      if (before.includes("\r\n")) {
        const fixed = before.toString("utf-8").replace(/\r\n/g, "\n");
        await fs.writeFile(file, Buffer.from(fixed, "utf-8"));
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
      name: "CrlfCheck",
      description: "Detects and fixes CRLF (\\r\\n) line endings, replacing them with LF (\\n).",
      options: "extensions — file extensions to check (e.g. [\".cpp\", \".h\", \".js\"])",
    };
  }
}
