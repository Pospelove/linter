import fs from "fs/promises";
import path from "path";
import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * Generic paired-files check.
 *
 * Configured via options in linter-config.json:
 *   dirs:    array of { path, ext, template? } — exactly two paired directories
 *   exclude: array of filenames to skip
 *
 * For each file in dir[0], expects a file with the same basename
 * but dir[1].ext in dir[1].path, and vice versa.
 *
 * If a dir entry includes a "template" string, fix() will create missing
 * pair files using that template. The placeholder {{name_without_ext}} is replaced
 * with the file's base name (without extension).
 */
export class PairedFilesCheck extends BaseCheck {
  #absDirs: Array<{ abs: string; ext: string; template: string | null }>;
  #exclude: Set<string>;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);

    const dirs = options["dirs"];
    if (!Array.isArray(dirs) || dirs.length !== 2) {
      throw new Error("PairedFilesCheck requires exactly 2 entries in options.dirs");
    }
    this.#absDirs = dirs.map((d: unknown) => {
      // @ts-expect-error - d is unknown but we expect an object with path and ext
      const obj: Record<string, unknown> = (d && typeof d === "object") ? d : {};
      return {
        abs: path.resolve(repoRoot, String(obj["path"] ?? "")),
        ext: String(obj["ext"] ?? ""),
        template: obj["template"] ? String(obj["template"]) : null,
      };
    });
    const exclude = options["exclude"];
    this.#exclude = new Set((Array.isArray(exclude) ? exclude : []).map((f: unknown) => String(f).toLowerCase()));
  }

  override get name(): string {
    return "Paired Files Check";
  }

  override getTemplates(): Record<string, (ctx: Record<string, unknown>) => string> {
    return {
      "{{name_without_ext}}": (ctx: Record<string, unknown>) => {
        const file = String(ctx["file"]);
        return path.basename(file, path.extname(file));
      },
    };
  }

  override async appliesTo(file: string): Promise<boolean> {
    if (!(await super.appliesTo(file))) return false;
    const basename = path.basename(file).toLowerCase();
    if (this.#exclude.has(basename)) return false;
    return this.#absDirs.some((d) => file.startsWith(d.abs + path.sep));
  }

  override async lint(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);

    const ownDir = this.#absDirs.find((d) => file.startsWith(d.abs + path.sep))!;
    const pairDir = this.#absDirs.find((d) => d !== ownDir)!;

    let pairFiles: string[];
    try {
      pairFiles = await fs.readdir(pairDir.abs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", output: `cannot read pair directory ${pairDir.abs}: ${msg}` };
    }

    const expected = `${baseName}${pairDir.ext}`;
    const found = pairFiles.find(
      (c) => c.toLowerCase() === expected.toLowerCase()
    );

    if (!found) {
      return { status: "fail", output: `pair file not found (expected ${expected} in ${pairDir.abs})` };
    }
    return { status: "pass" };
  }

  override async fix(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);

    const ownDir = this.#absDirs.find((d) => file.startsWith(d.abs + path.sep))!;
    const pairDir = this.#absDirs.find((d) => d !== ownDir)!;

    const expected = `${baseName}${pairDir.ext}`;
    const pairPath = path.join(pairDir.abs, expected);

    let pairFiles: string[];
    try {
      pairFiles = await fs.readdir(pairDir.abs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", output: `cannot read pair directory ${pairDir.abs}: ${msg}` };
    }

    const found = pairFiles.find(
      (c) => c.toLowerCase() === expected.toLowerCase()
    );

    if (found) {
      return { status: "pass" };
    }

    if (!pairDir.template) {
      return { status: "fail", output: `pair file not found (expected ${expected} in ${pairDir.abs})` };
    }

    const content = this.resolveTemplate(pairDir.template, { file });
    try {
      await fs.writeFile(pairPath, content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", output: `failed to create ${pairPath}: ${msg}` };
    }
    return { status: "fixed", output: `created ${pairPath}`, extraFiles: [pairPath] };
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "PairedFilesCheck",
      description: "Ensures matching files exist across two directories (e.g. src/*.cpp ↔ include/*.h). Can auto-create missing files when a template is provided.",
      options: 'dirs — array of 2 objects { "path": "...", "ext": "...", "template?": "..." } ({{name_without_ext}} is replaced); exclude — filenames to skip',
    };
  }
}
