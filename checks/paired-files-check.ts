import { promises as fs } from "fs";
import path from "path";
import { BaseCheck } from "./base-check.js";

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
  #absDirs;
  #exclude;

  constructor(repoRoot, options = {}) {
    super(repoRoot, options);

    const dirs = options.dirs || [];
    if (dirs.length !== 2) {
      throw new Error("PairedFilesCheck requires exactly 2 entries in options.dirs");
    }
    this.#absDirs = dirs.map((d) => ({
      abs: path.resolve(repoRoot, d.path),
      ext: d.ext,
      template: d.template || null,
    }));
    this.#exclude = new Set((options.exclude || []).map((f) => f.toLowerCase()));
  }

  get name() {
    return "Paired Files Check";
  }

  getTemplates() {
    return {
      "{{name_without_ext}}": (ctx) => path.basename(ctx.file, path.extname(ctx.file)),
    };
  }

  async appliesTo(file) {
    if (!(await super.appliesTo(file))) return false;
    const basename = path.basename(file).toLowerCase();
    if (this.#exclude.has(basename)) return false;
    return this.#absDirs.some((d) => file.startsWith(d.abs + path.sep));
  }

  async lint(file) {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);

    const ownDir = this.#absDirs.find((d) => file.startsWith(d.abs + path.sep));
    const pairDir = this.#absDirs.find((d) => d !== ownDir);

    let pairFiles;
    try {
      pairFiles = await fs.readdir(pairDir.abs);
    } catch (err) {
      return { status: "error", output: `cannot read pair directory ${pairDir.abs}: ${err.message}` };
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

  async fix(file) {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);

    const ownDir = this.#absDirs.find((d) => file.startsWith(d.abs + path.sep));
    const pairDir = this.#absDirs.find((d) => d !== ownDir);

    const expected = `${baseName}${pairDir.ext}`;
    const pairPath = path.join(pairDir.abs, expected);

    let pairFiles;
    try {
      pairFiles = await fs.readdir(pairDir.abs);
    } catch (err) {
      return { status: "error", output: `cannot read pair directory ${pairDir.abs}: ${err.message}` };
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
    } catch (err) {
      return { status: "error", output: `failed to create ${pairPath}: ${err.message}` };
    }
    return { status: "fixed", output: `created ${pairPath}`, extraFiles: [pairPath] };
  }

  static getHelp() {
    return {
      name: "PairedFilesCheck",
      description: "Ensures matching files exist across two directories (e.g. src/*.cpp ↔ include/*.h). Can auto-create missing files when a template is provided.",
      options: 'dirs — array of 2 objects { "path": "...", "ext": "...", "template?": "..." } ({{name_without_ext}} is replaced); exclude — filenames to skip',
    };
  }
}
