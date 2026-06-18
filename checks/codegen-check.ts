import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { BaseCheck } from "./base-check.js";

const execFileAsync = promisify(execFile);

/**
 * Codegen check — verifies that generated output files are up-to-date
 * with their source input files.
 *
 * Options (from linter-config.json):
 *   command    — shell command to run (the generator), e.g. "node codegen.js"
 *   inputFile  — path to input file (relative to repo root)
 *   outputFile — path to output file (relative to repo root)
 *
 * Lint mode:
 *   1. Read current outputFile contents into memory
 *   2. Run command (which overwrites outputFile)
 *   3. Read new outputFile contents
 *   4. Restore original contents from memory (rollback without git)
 *   5. Compare — if different, report "fail"
 *
 * Fix mode:
 *   1. Run command (which overwrites outputFile)
 *   2. Updated file becomes part of the commit
 */
export class CodegenCheck extends BaseCheck {
  #command;
  #inputFile;
  #outputFile;
  #absInput;
  #absOutput;

  constructor(repoRoot, options = {}) {
    super(repoRoot, options);
    if (!options.command) throw new Error("CodegenCheck requires options.command");
    if (!options.inputFile) throw new Error("CodegenCheck requires options.inputFile");
    if (!options.outputFile) throw new Error("CodegenCheck requires options.outputFile");

    this.#command = options.command;
    this.#inputFile = options.inputFile;
    this.#outputFile = options.outputFile;
    this.#absInput = path.resolve(repoRoot, options.inputFile);
    this.#absOutput = path.resolve(repoRoot, options.outputFile);
  }

  get name() {
    return `Codegen (${this.#inputFile} → ${this.#outputFile})`;
  }

  /**
   * Only applies to the input file — the check triggers when the source changes.
   */
  async appliesTo(file) {
    if (!(await super.appliesTo(file))) return false;
    return path.resolve(file) === this.#absInput;
  }

  async lint(file, _deps) {
    // TODO: consider more efficient impl — e.g. run command writing to a temp
    // file instead of overwriting the real output and rolling back.

    // 1. Save current output contents into memory
    let original;
    try {
      original = await fs.readFile(this.#absOutput);
    } catch (err) {
      if (err.code === "ENOENT") {
        original = null; // output does not exist yet
      } else {
        return { status: "error", output: `cannot read output file: ${err.message}` };
      }
    }

    // 2. Run the generator command
    try {
      await this.#runCommand();
    } catch (err) {
      // Restore before returning error
      await this.#restore(original);
      return { status: "error", output: `command failed: ${err}` };
    }

    // 3. Read generated output
    let generated;
    try {
      generated = await fs.readFile(this.#absOutput);
    } catch (err) {
      await this.#restore(original);
      return { status: "error", output: `cannot read generated output: ${err.message}` };
    }

    // 4. Restore original contents (rollback without git)
    await this.#restore(original);

    // 5. Compare
    if (original === null) {
      return { status: "fail", output: `output file ${this.#outputFile} did not exist before codegen — file is stale` };
    }
    if (!original.equals(generated)) {
      return { status: "fail", output: `output file ${this.#outputFile} is stale — re-run codegen to update` };
    }
    return { status: "pass" };
  }

  async fix(file, _deps) {
    // Just run the command — let it write the output file
    try {
      await this.#runCommand();
    } catch (err) {
      return { status: "error", output: `command failed: ${err}` };
    }
    return { status: "fixed", extraFiles: [this.#absOutput] };
  }

  async #runCommand() {
    const parts = this.#command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    await execFileAsync(cmd, args, { cwd: this.repoRoot });
  }

  async #restore(original) {
    if (original === null) {
      // File did not exist — remove the generated one
      try {
        await fs.unlink(this.#absOutput);
      } catch {
        // ignore if already gone
      }
    } else {
      await fs.writeFile(this.#absOutput, original);
    }
  }

  static getHelp() {
    return {
      name: "CodegenCheck",
      description:
        "Verifies generated output files are up-to-date. " +
        "Lint reads output into RAM, runs generator, compares, and rolls back. " +
        "Fix just runs the generator.",
      options:
        'command — generator command to run; ' +
        'inputFile — source file path (relative to repo root); ' +
        'outputFile — generated file path (relative to repo root)',
    };
  }
}
