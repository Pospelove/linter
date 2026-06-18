import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck } from "./base-check.js";
import { promises as fs } from "fs";
import { getLinelintPath } from "../tool-resolve/linelint.js";

const execFileAsync = promisify(execFile);

export class LinelintCheck extends BaseCheck {
  constructor(repoRoot, options = {}) {
    super(repoRoot, options);
  }

  get name() {
    return "Linelint";
  }

  async resolveDeps(options) {
    const linelintPath = await getLinelintPath(options);
    return { linelintPath };
  }

  checkDeps(deps) {
    return deps.linelintPath !== undefined;
  }

  async lint(file, deps) {
    try {
      await execFileAsync(deps.linelintPath, [file], { cwd: this.repoRoot });
      return { status: "pass" };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { status: "error", output: err.message };
      }
      const out = (err.stderr || err.stdout || "").toString().trim();
      return { status: "fail", output: out || "linelint failed" };
    }
  }

  async fix(file, deps) {
    let before;
    try {
      before = await fs.readFile(file);
    } catch (err) {
      return { status: "error", output: err.message };
    }

    try {
      await execFileAsync(deps.linelintPath, ["-a", file], { cwd: this.repoRoot });
    } catch (err) {
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
    } catch (err) {
      return { status: "error", output: err.message };
    }
  }

  static getHelp() {
    return {
      name: "LinelintCheck",
      description: "Runs linelint to enforce final-newline and trailing-whitespace rules. Auto-downloads the binary if needed.",
      options: "(uses linelint config from repo root)",
    };
  }
}
