import fs from "fs/promises";
import path from "path";
import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * Generic regex-based check, fully driven by options in linter-config.json.
 *
 * Options:
 *   pattern        — regex string to find violations (required)
 *   patternFlags   — regex flags (default: "g")
 *   replacement    — replacement string for fix mode (uses $1, $2, … groups)
 *                    Supports templates: {name_without_ext} (filename without ext),
 *                    {name_with_ext} (filename with ext), {ext} (extension with dot),
 *                    {dir} (directory relative to repo root).
 *   multiline      — if true, regex operates on entire file content instead of
 *                    per-line (default: false). Useful for multi-line patterns.
 *   message        — error message shown on violation (default: "regex violation")
 *   skipLinePatterns — array of regex strings; matching lines are skipped
 *                    (ignored when multiline is true)
 *
 * Example config entry (localization enforcement):
 *   {
 *     "name": "localization",
 *     "export": "RegexCheck",
 *     "modes": ["manual", "hook", "ci"],
 *     "options": {
 *       "extensions": [".js", ".ts", ".cpp", ".h"],
 *       "pattern": "(?<!_L\\()([\"'`])([^\"'`]*[\\u0400-\\u04FF]+[^\"'`]*)\\1",
 *       "replacement": "_L($1$2$1, user)",
 *       "message": "Cyrillic string not wrapped with _L()",
 *       "skipLinePatterns": ["^\\s*\\/\\/", "^\\s*\\*"]
 *     }
 *   }
 */
export class RegexCheck extends BaseCheck {
  #pattern: RegExp;
  #replacement: string | null;
  #message: string;
  #multiline: boolean;
  #skipLineRes: RegExp[];

  constructor(repoRoot: string, options: any = {}) {
    super(repoRoot, options);

    if (!options.pattern) {
      throw new Error("RegexCheck requires a 'pattern' option");
    }

    const flags = options.patternFlags || "g";
    this.#pattern = new RegExp(options.pattern, flags.includes("g") ? flags : flags + "g");
    
    this.#replacement = options.replacement ?? null;
    this.#message = options.message ?? "regex violation";
    this.#multiline = !!options.multiline;
    this.#skipLineRes = (options.skipLinePatterns || []).map((p: string) => new RegExp(p));
  }

  override get name(): string {
    return this.#message;
  }

  override getTemplates(): Record<string, (ctx: any) => string> {
    return {
      "{name_without_ext}": (ctx: any) => path.basename(ctx.file, path.extname(ctx.file)),
      "{name_with_ext}":    (ctx: any) => path.basename(ctx.file),
      "{ext}":              (ctx: any) => path.extname(ctx.file),
      "{dir}":              (ctx: any) => path.dirname(path.relative(ctx.repoRoot, ctx.file)),
    };
  }

  override async lint(file: string, _deps: any): Promise<CheckResult> {
    try {
      const content = await fs.readFile(file, "utf-8");
      const violations: string[] = [];
      const re = new RegExp(this.#pattern.source, this.#pattern.flags);

      if (this.#multiline) {
        const lineOffsets = [0];
        for (let i = 0; i < content.length; i++) {
          if (content[i] === '\n') lineOffsets.push(i + 1);
        }

        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const lineNo = lineOffsets.filter(offset => offset <= m!.index).length;
          const matchText = m[0].length > 80 ? m[0].slice(0, 80) + "…" : m[0];
          violations.push(`  line ${lineNo}: ${matchText.replace(/\n/g, '\\n')}`);
        }
      } else {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          if (this.#skipLineRes.some((skip: RegExp) => skip.test(line))) continue;

          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(line)) !== null) {
            violations.push(`  line ${i + 1}: ${m[0]}`);
            if (!re.flags.includes("g")) break;
          }
        }
      }

      if (violations.length > 0) {
        return {
          status: "fail",
          output: `${this.#message} (${violations.length} hit(s)):\n${violations.join("\n")}`,
        };
      }
      return { status: "pass" };
    } catch (err: any) {
      return { status: "error", output: err.message };
    }
  }

  override async fix(file: string, _deps: any): Promise<CheckResult> {
    if (!this.#replacement) return this.lint(file, _deps);

    try {
      const original = await fs.readFile(file, "utf-8");
      const replacement = this.resolveTemplate(this.#replacement, {
        file: path.resolve(file),
        repoRoot: this.repoRoot,
      });

      let fixed: string;
      const re = new RegExp(this.#pattern.source, this.#pattern.flags);

      if (this.#multiline || this.#skipLineRes.length === 0) {
        fixed = original.replace(re, replacement);
      } else {
        const lines = original.split("\n");
        fixed = lines.map((line) => {
          if (this.#skipLineRes.some((skip: RegExp) => skip.test(line))) return line;
          return line.replace(re, replacement);
        }).join("\n");
      }

      if (fixed !== original) {
        await fs.writeFile(file, fixed, "utf-8");
        return { status: "fixed" };
      }
      return { status: "pass" };
    } catch (err: any) {
      return { status: "error", output: err.message };
    }
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "RegexCheck",
      description: "Generic regex-based check and fix.",
      options: "pattern, patternFlags, replacement, multiline, message, skipLinePatterns",
    };
  }
}
