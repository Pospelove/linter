import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { BaseCheck, CheckResult } from "./base-check.js";

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
  #command: string;
  #inputFile: string;
  #outputFile: string;
  #absInput: string;
  #absOutput: string;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    const command = options["command"];
    const inputFile = options["inputFile"];
    const outputFile = options["outputFile"];

    if (typeof command !== "string") throw new Error("CodegenCheck requires options.command to be a string");
    if (typeof inputFile !== "string") throw new Error("CodegenCheck requires options.inputFile to be a string");
    if (typeof outputFile !== "string") throw new Error("CodegenCheck requires options.outputFile to be a string");

    this.#command = command;
    this.#inputFile = inputFile;
    this.#outputFile = outputFile;
    this.#absInput = path.resolve(repoRoot, inputFile);
    this.#absOutput = path.resolve(repoRoot, outputFile);
  }

  override get name(): string {
    return `Codegen (${this.#inputFile} → ${this.#outputFile})`;
  }

  /**
   * Only applies to the input file — the check triggers when the source changes.
   */
  override async appliesTo(file: string): Promise<boolean> {
    if (!(await super.appliesTo(file))) return false;
    return path.resolve(file) === this.#absInput;
  }

  override async lint(_file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    // TODO: consider more efficient impl — e.g. run command writing to a temp
    // file instead of overwriting the real output and rolling back.

    // 1. Save current output contents into memory
    let original: Buffer | null;
    try {
      original = await fs.readFile(this.#absOutput);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        original = null; // output does not exist yet
      } else {
        const message = err instanceof Error ? err.message : String(err);
        return { status: "error", output: `cannot read output file: ${message}` };
      }
    }

    // 2. Run the generator command
    try {
      await this.#runCommand();
    } catch (err: unknown) {
      // Restore before returning error
      await this.#restore(original);
      return { status: "error", output: `command failed: ${String(err)}` };
    }

    // 3. Read generated output
    let generated: Buffer;
    try {
      generated = await fs.readFile(this.#absOutput);
    } catch (err: unknown) {
      await this.#restore(original);
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", output: `cannot read generated output: ${message}` };
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

  override async fix(_file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    // Just run the command — let it write the output file
    try {
      await this.#runCommand();
    } catch (err: unknown) {
      return { status: "error", output: `command failed: ${String(err)}` };
    }
    return { status: "fixed", extraFiles: [this.#absOutput] };
  }

  async #runCommand(): Promise<void> {
    const parts = this.#command.split(/\s+/);
    const cmd = parts[0];
    if (!cmd) throw new Error("Command is empty");
    const args = parts.slice(1);
    await execFileAsync(cmd, args, { cwd: this.repoRoot });
  }

  async #restore(original: Buffer | null): Promise<void> {
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

  static override getHelp(): { name: string; description: string; options: string } {
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
