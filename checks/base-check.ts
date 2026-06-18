import path from "path";
import fs from "fs/promises";
import { FileExpander } from "../expanders/file-expander.js";

/**
 * @typedef {"pass" | "fail" | "fixed" | "error"} CheckStatus
 */

export type CheckStatus = "pass" | "fail" | "fixed" | "error";

/**
 * @typedef {Object} CheckResult
 * @property {CheckStatus} status  - Outcome of the check.
 * @property {string}      [output] - Optional diagnostic text (diff, error message, etc.).
 */

export interface CheckResult {
  status: CheckStatus;
  output?: string;
  extraFiles?: string[];
}

/**
 * Base class for all linter checks.
 * Subclasses must implement: name, checkDeps, lint, fix.
 *
 * appliesTo() is provided by BaseCheck using options from config:
 *   options.extensions   - array of extensions to include (e.g. [".cpp", ".h"])
 *   options.includePaths - array of path substrings; file must match at least one (if set)
 *   options.excludePaths - array of path substrings to skip
 *   options.textOnly     - if true, skip binary files (default: false)
 *   options.priority     - numeric priority (lower runs first, default: 0)
 *
 * All methods that touch files are async.
 * appliesTo(), lint() and fix() return Promises.
 *
 * Checks must NOT write to stdout/stderr directly.
 */
export class BaseCheck {
  repoRoot: string;
  #extensions: string[];
  #includePaths: string[];
  #excludePaths: string[];
  #textOnly: boolean;
  #priority: number;
  #expander: import("../expanders/base-expander.js").BaseExpander | null;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    this.repoRoot = repoRoot;
    
    const extensions = options["extensions"];
    this.#extensions = Array.isArray(extensions) 
      ? extensions.map((e) => String(e).toLowerCase()) 
      : [];

    const includePaths = options["includePaths"];
    this.#includePaths = Array.isArray(includePaths)
      ? includePaths.filter((p): p is string => typeof p === "string")
      : [];

    const excludePaths = options["excludePaths"];
    this.#excludePaths = Array.isArray(excludePaths)
      ? excludePaths.filter((p): p is string => typeof p === "string")
      : [];

    this.#textOnly = !!options["textOnly"];
    this.#priority = typeof options["priority"] === "number" ? options["priority"] : 0;
    this.#expander = null;
  }

  /**
   * @returns {number} Numeric priority (lower runs first).
   */
  get priority(): number {
    return this.#priority;
  }

  /**
   * @returns {string} Human-readable name of the check.
   */
  get name(): string {
    throw new Error("Not implemented: name");
  }

  /**
   * Set the expander used by expand().
   * Called by the runner when "expander" is configured for this check.
   * @param {import("../expanders/base-expander.js").BaseExpander} expander
   */
  setExpander(expander: import("../expanders/base-expander.js").BaseExpander): void {
    this.#expander = expander;
  }

  /**
   * Expand a file into one or more entries.
   * By default delegates to FileExpander (one FileEntry per file).
   * Override or configure a custom expander via "expander" in linter-config.json
   * to produce multiple entries from a single file.
   * @param {string} file - Absolute path to the file.
   * @returns {Promise<import("../entries/base-entry.js").BaseEntry[]>}
   */
  async expand(file: string): Promise<import("../entries/base-entry.js").BaseEntry[]> {
    let expander = this.#expander;
    if (!expander) {
      expander = this.#expander = new FileExpander();
    }
    return expander.expand(file);
  }

  /**
   * Whether this check's dependencies are satisfied.
   * @param {Record<string, unknown>} _deps - Resolved dependencies (e.g. { clangFormatPath }).
   * @returns {boolean}
   */
  checkDeps(_deps: Record<string, unknown>): boolean {
    return true;
  }

  /**
   * Whether this check applies to the given file.
   * Uses config-driven extensions, excludePaths, and textOnly.
   * Subclasses can override for extra logic but should await super.appliesTo().
   * @param {string} file - Absolute path to the file.
   * @returns {Promise<boolean>}
   */
  async appliesTo(file: string): Promise<boolean> {
    // Normalize to forward slashes so includePaths/excludePaths (always written
    // with forward slashes) match correctly on Windows too.
    const normalizedFile = file.replace(/\\/g, "/");

    // includePaths check (if set, file must match at least one)
    if (this.#includePaths.length > 0) {
      if (!this.#includePaths.some((p) => normalizedFile.includes(p))) return false;
    }

    // excludePaths check
    for (const p of this.#excludePaths) {
      if (normalizedFile.includes(p)) return false;
    }

    // extensions filter (empty = all extensions allowed)
    if (this.#extensions.length > 0) {
      const ext = path.extname(file).toLowerCase();
      if (!this.#extensions.includes(ext)) return false;
    }

    // binary file detection
    if (this.#textOnly) {
      let fh;
      try {
        fh = await fs.open(file, "r");
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await fh.read(buffer, 0, 1024, 0);
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 0) return false;
        }
      } catch {
        return false;
      } finally {
        if (fh) await fh.close();
      }
    }

    return true;
  }

  /**
   * Resolve and download tools this check depends on.
   * Called once before running lint/fix. The returned object is merged
   * into the shared deps bag.
   * Subclasses should override to download/locate their tools.
   * @param {Record<string, unknown>} _options
   * @returns {Promise<Record<string, unknown>>} Key-value pairs to merge into deps.
   */
  async resolveDeps(_options: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }

  /**
   * Lint (read-only check) a single file.
   * @param {string} _file - Absolute path.
   * @param {Record<string, unknown>} _deps - Resolved dependencies.
   * @param {import("../entries/base-entry.js").BaseEntry} [_entry] - The entry being processed; provides metadata for sub-file checks.
   * @returns {Promise<CheckResult>}
   */
  async lint(_file: string, _deps: Record<string, unknown>, _entry: import("../entries/base-entry.js").BaseEntry | null = null): Promise<CheckResult> {
    throw new Error("Not implemented: lint");
  }

  /**
   * Fix (in-place modify) a single file.
   * @param {string} _file - Absolute path.
   * @param {Record<string, unknown>} _deps - Resolved dependencies.
   * @param {import("../entries/base-entry.js").BaseEntry} [_entry] - The entry being processed; provides metadata for sub-file checks.
   * @returns {Promise<CheckResult>}
   */
  async fix(_file: string, _deps: Record<string, unknown>, _entry: import("../entries/base-entry.js").BaseEntry | null = null): Promise<CheckResult> {
    throw new Error("Not implemented: fix");
  }

  /**
   * Optional combined lint+fix in a single operation.
   * Checks that can evaluate and fix in one step (e.g. a single AI call)
   * should override this. Return null to signal that the check does not
   * support combined mode — the runner will fall back to fix().
   * @param {string} _file - Absolute path.
   * @param {Record<string, unknown>} _deps - Resolved dependencies.
   * @param {import("../entries/base-entry.js").BaseEntry} [_entry] - The entry being processed; provides metadata for sub-file checks.
   * @returns {Promise<CheckResult | null>}
   */
  async lintAndFix(_file: string, _deps: Record<string, unknown>, _entry: import("../entries/base-entry.js").BaseEntry | null = null): Promise<CheckResult | null> {
    return null;
  }

  // ── In-memory (string in / string out) interface ─────────────────────
  //
  // Checks that can operate on raw content strings (without doing their own
  // file I/O) should override the *InMemory methods and set supportsInMemory
  // to true. The runner always prefers this path when available, so the same
  // check works for whole files (FileEntry) and for virtual slices
  // (JsonArrayEntry, etc.) without any per-entry-type code in the check.
  //
  // The runner aborts with a clear error if a virtual entry is paired with a
  // check that does not declare supportsInMemory.
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Whether this check implements the in-memory (*InMemory) interface.
   * @returns {boolean}
   */
  get supportsInMemory(): boolean {
    return false;
  }

  /**
   * Lint a content string. Override when supportsInMemory is true.
   * @param {string} _content - The slice of file content to evaluate.
   * @param {Record<string, unknown>} _deps
   * @param {import("../entries/base-entry.js").BaseEntry} _entry - The entry being processed (for id, sourceFile, metadata).
   * @returns {Promise<CheckResult>}
   */
  async lintInMemory(_content: string, _deps: Record<string, unknown>, _entry: import("../entries/base-entry.js").BaseEntry): Promise<CheckResult> {
    throw new Error("Not implemented: lintInMemory");
  }

  /**
   * Fix a content string. Override when supportsInMemory is true.
   * Returns CheckResult plus an optional `content` field with the new string;
   * the runner pipes that back through entry.writeBack() when status === "fixed".
   * @param {string} _content
   * @param {Record<string, unknown>} _deps
   * @param {import("../entries/base-entry.js").BaseEntry} _entry
   * @returns {Promise<CheckResult & { content?: string }>}
   */
  async fixInMemory(_content: string, _deps: Record<string, unknown>, _entry: import("../entries/base-entry.js").BaseEntry): Promise<CheckResult & { content?: string }> {
    throw new Error("Not implemented: fixInMemory");
  }

  /**
   * Optional combined lint+fix on a content string. Same null-fallback
   * semantics like lintAndFix(). Returns CheckResult plus optional `content`.
   * @param {string} _content
   * @param {Record<string, unknown>} _deps
   * @param {import("../entries/base-entry.js").BaseEntry} _entry
   * @returns {Promise<(CheckResult & { content?: string }) | null>}
   */
  async lintAndFixInMemory(_content: string, _deps: Record<string, unknown>, _entry: import("../entries/base-entry.js").BaseEntry): Promise<(CheckResult & { content?: string }) | null> {
    return null;
  }

  /**
   * Return template placeholders this check supports.
   * Keys are placeholder strings, values are functions (context) => replacement.
   * Subclasses override to provide their own templates.
   * @returns {Record<string, (ctx: Record<string, unknown>) => string>}
   */
  getTemplates(): Record<string, (ctx: Record<string, unknown>) => string> {
    return {};
  }

  /**
   * Expand all placeholders from getTemplates() in the given string.
   * @param {string} template - String containing placeholders.
   * @param {Record<string, unknown>} context  - Passed to each template function.
   * @returns {string}
   */
  resolveTemplate(template: string, context: Record<string, unknown>): string {
    let result = template;
    for (const [placeholder, fn] of Object.entries(this.getTemplates())) {
      result = result.replaceAll(placeholder, fn(context));
    }
    return result;
  }

  /**
   * Return help info for this check class.
   * Subclasses should override to provide specific details.
   * @returns {{ name: string, description: string, options: string }}
   */
  static getHelp(): { name: string; description: string; options: string } {
    return { name: "BaseCheck", description: "Abstract base class for checks.", options: "extensions, includePaths, excludePaths, textOnly, priority, expander" };
  }
}
