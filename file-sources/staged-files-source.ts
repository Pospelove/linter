import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import { BaseFileSource } from "./base-file-source.js";

/**
 * Returns files currently staged in git (--cached).
 * Typical use: pre-commit hook.
 */
export class StagedFilesSource extends BaseFileSource {
  get name() {
    return "Staged files";
  }

  async resolve() {
    const git = simpleGit(this.repoRoot);
    const output = await git.diff(["--name-only", "--diff-filter=ACMR", "--cached"]);
    const files = output
      .split("\n")
      .filter((f) => f.trim() !== "")
      .map((f) => path.resolve(this.repoRoot, f));

    const existing = await Promise.all(
      files.map(async (filePath) => {
        try {
          await fs.promises.access(filePath, fs.constants.F_OK);
          return filePath;
        } catch {
          return null;
        }
      }),
    );

    return existing.filter((filePath) => filePath !== null);
  }

  static getHelp() {
    return {
      name: "StagedFilesSource",
      description: "Files currently staged in git (git diff --cached). Typical use: pre-commit hook.",
      options: "(none)",
    };
  }
}
