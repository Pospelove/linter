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
  #includePatterns: string[];
  #excludePatterns: string[];

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    const include = options["include"];
    this.#includePatterns = Array.isArray(include)
      ? include.filter((i): i is string => typeof i === "string")
      : typeof include === "string"
        ? [include]
        : [];
    const exclude = options["exclude"];
    this.#excludePatterns = Array.isArray(exclude)
      ? exclude.filter((i): i is string => typeof i === "string")
      : typeof exclude === "string"
        ? [exclude]
        : [];
    this.name = "All tracked files";
  }

  override async resolve(): Promise<string[]> {
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

    return existing.filter((filePath): filePath is string => filePath !== null);
  }

  static override getHelp() {
    return {
      name: "AllFilesSource",
      description: "All git-tracked files in the repo. Typical use: manual full-repo check.",
      options: "include — glob pattern(s) to include (e.g. [\"**/*.ts\"]); exclude — glob pattern(s) to exclude",
    };
  }
}

function matchGlob(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  const f = filePath.replace(/\\/g, "/");
  let regex = "";
  let i = 0;
  while (i < p.length) {
    if (p.charAt(i) === "*" && p.charAt(i + 1) === "*") {
      if (p.charAt(i + 2) === "/") {
        regex += "(?:.+/)?"; // **/ = zero or more path segments
        i += 3;
      } else {
        regex += ".*"; // ** at end
        i += 2;
      }
    } else if (p.charAt(i) === "*") {
      regex += "[^/]*";
      i++;
    } else {
      regex += p.charAt(i).replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regex}$`).test(f);
}
