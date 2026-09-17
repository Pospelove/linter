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
 *   3. GITHUB_EVENT_NAME == "push" → origin/ + default branch from GITHUB_DEFAULT_BRANCH or "main"
 *   4. Throws if nothing found.
 *
 * Special case: a push directly to the default branch (e.g. a merge landing on main) has
 * nothing to diff against — HEAD already *is* the base — so instead of silently checking 0
 * files, all tracked files are returned.
 *
 * Typical use: CI / GitHub Actions.
 */
export class DiffBaseSource extends BaseFileSource {
  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    this.name = "Diff vs base";
  }

  override async resolve(): Promise<string[]> {
    if (this.#isPushToDefaultBranch()) {
      console.log(
        "DiffBaseSource: push to default branch detected — nothing to diff against, checking all tracked files instead",
      );
      const git = simpleGit(this.repoRoot);
      const output = await git.raw(["ls-files"]);
      return this.#resolveExistingFiles(output);
    }

    const baseRef = this.#detectBaseRef();
    console.log(`DiffBaseSource: diffing against ${baseRef}`);

    const git = simpleGit(this.repoRoot);
    const output = await git.diff(["--name-only", "--diff-filter=ACMR", baseRef]);
    return this.#resolveExistingFiles(output);
  }

  async #resolveExistingFiles(rawOutput: string): Promise<string[]> {
    const files = rawOutput
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

    return existing.filter((filePath): filePath is string => filePath !== null);
  }

  #isPushToDefaultBranch(): boolean {
    // Explicit base ref always wins — the caller knows what they want.
    if (typeof this.options["baseRef"] === "string") return false;
    // Not a push event (or it's a pull_request event with GITHUB_BASE_REF set).
    if (process.env["GITHUB_EVENT_NAME"] !== "push") return false;
    if (process.env["GITHUB_BASE_REF"]) return false;

    const defaultBranch = process.env["GITHUB_DEFAULT_BRANCH"] || "main";
    const pushedRef = process.env["GITHUB_REF_NAME"];
    return pushedRef === defaultBranch;
  }

  #detectBaseRef(): string {
    // 1. Explicit config
    const baseRef = this.options["baseRef"];
    if (typeof baseRef === "string") {
      console.log(`DiffBaseSource: using options.baseRef = "${baseRef}"`);
      return baseRef;
    }

    // 2. GitHub Actions pull_request event
    const ghBaseRef = process.env["GITHUB_BASE_REF"];
    if (ghBaseRef) {
      console.log(`DiffBaseSource: using GITHUB_BASE_REF = "${ghBaseRef}" → origin/${ghBaseRef}`);
      return `origin/${ghBaseRef}`;
    }

    // 3. GitHub Actions push event — diff against default branch
    if (process.env["GITHUB_EVENT_NAME"] === "push") {
      const defaultBranch = process.env["GITHUB_DEFAULT_BRANCH"] || "main";
      console.log(`DiffBaseSource: GITHUB_EVENT_NAME = "push", using default branch "${defaultBranch}" → origin/${defaultBranch}`);
      return `origin/${defaultBranch}`;
    }

    throw new Error(
      "DiffBaseSource: cannot determine base ref. " +
        "Set options.baseRef in config, or run in GitHub Actions (GITHUB_BASE_REF / GITHUB_EVENT_NAME)."
    );
  }

  static override getHelp() {
    return {
      name: "DiffBaseSource",
      description: "Files changed relative to a base branch/ref. Auto-detects GITHUB_BASE_REF in GitHub Actions; on a push directly to the default branch, checks all tracked files instead. Typical use: CI.",
      options: "baseRef — explicit base ref to diff against (optional, auto-detected in GHA)",
    };
  }
}
