import fs from "fs";
import path from "path";
import simpleGit from "simple-git";
import { BaseFileSource } from "./base-file-source.js";

/**
 * Returns all tracked files in the repo.
 * Typical use: manual full-repo check.
 *
 * Options:
 *   include — glob pattern(s) to include (e.g. ["**\/*.ts"]). Omit to include all.
 *   exclude — glob pattern(s) to exclude.
 */
export class AllFilesSource extends BaseFileSource {
  #includePatterns;
  #excludePatterns;

  constructor(repoRoot, options = {}) {
    super(repoRoot, options);
    const coerceArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
    this.#includePatterns = coerceArray(options.include);
    this.#excludePatterns = coerceArray(options.exclude);
  }

  get name() {
    return "All tracked files";
  }

  async resolve() {
    const git = simpleGit(this.repoRoot);
    const output = await git.raw(["ls-files"]);
    const files = output
      .split("\n")
      .filter((f) => f.trim() !== "")
      .filter((rel) => {
        if (this.#includePatterns.length > 0 && !this.#includePatterns.some((p) => matchGlob(p, rel))) return false;
        if (this.#excludePatterns.some((p) => matchGlob(p, rel))) return false;
        return true;
      })
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
      name: "AllFilesSource",
      description: "All git-tracked files in the repo. Typical use: manual full-repo check.",
      options: "include — glob pattern(s) to include (e.g. [\"**/*.ts\"]); exclude — glob pattern(s) to exclude",
    };
  }
}

function matchGlob(pattern, filePath) {
  const p = pattern.replace(/\\/g, "/");
  const f = filePath.replace(/\\/g, "/");
  let regex = "";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        regex += "(?:.+/)?"; // **/ = zero or more path segments
        i += 3;
      } else {
        regex += ".*"; // ** at end
        i += 2;
      }
    } else if (p[i] === "*") {
      regex += "[^/]*";
      i++;
    } else {
      regex += p[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regex}$`).test(f);
}
