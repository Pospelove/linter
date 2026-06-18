import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import { BaseFileSource } from "./base-file-source.js";

/**
 * Returns files changed compared to a base branch/ref.
 *
 * Base ref resolution order:
 *   1. options.baseRef from linter-config.json
 *   2. GITHUB_BASE_REF env var (set by GHA on pull_request events) → origin/$GITHUB_BASE_REF
 *   3. GITHUB_EVENT_NAME == "push" → origin/ + default branch from GITHUB_REF_NAME or "main"
 *   4. Throws if nothing found.
 *
 * Typical use: CI / GitHub Actions.
 */
export class DiffBaseSource extends BaseFileSource {
  get name() {
    return "Diff vs base";
  }

  async resolve() {
    const baseRef = this.#detectBaseRef();
    console.log(`DiffBaseSource: diffing against ${baseRef}`);

    const git = simpleGit(this.repoRoot);
    const output = await git.diff(["--name-only", "--diff-filter=ACMR", baseRef]);
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

  #detectBaseRef() {
    // 1. Explicit config
    if (this.options.baseRef) {
      console.log(`DiffBaseSource: using options.baseRef = "${this.options.baseRef}"`);
      return this.options.baseRef;
    }

    // 2. GitHub Actions pull_request event
    const ghBaseRef = process.env.GITHUB_BASE_REF;
    if (ghBaseRef) {
      console.log(`DiffBaseSource: using GITHUB_BASE_REF = "${ghBaseRef}" → origin/${ghBaseRef}`);
      return `origin/${ghBaseRef}`;
    }

    // 3. GitHub Actions push event — diff against default branch
    if (process.env.GITHUB_EVENT_NAME === "push") {
      const defaultBranch = process.env.GITHUB_DEFAULT_BRANCH || "main";
      console.log(`DiffBaseSource: GITHUB_EVENT_NAME = "push", using default branch "${defaultBranch}" → origin/${defaultBranch}`);
      return `origin/${defaultBranch}`;
    }

    throw new Error(
      "DiffBaseSource: cannot determine base ref. " +
        "Set options.baseRef in config, or run in GitHub Actions (GITHUB_BASE_REF / GITHUB_EVENT_NAME)."
    );
  }

  static getHelp() {
    return {
      name: "DiffBaseSource",
      description: "Files changed relative to a base branch/ref. Auto-detects GITHUB_BASE_REF in GitHub Actions. Typical use: CI.",
      options: "baseRef — explicit base ref to diff against (optional, auto-detected in GHA)",
    };
  }
}
