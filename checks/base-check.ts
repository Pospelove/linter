import path from "path";
import fs from "fs/promises";

/**
 * @typedef {"pass" | "fail" | "fixed" | "error"} CheckStatus
 */

export type CheckStatus = "pass" | "fail" | "fixed" | "error";

/**
 * A machine-readable finding attached to a CheckResult. Populated by
 * per-finding-aware checks; the runner also synthesizes one whole-file
 * finding for legacy fail/error results (see docs/per-finding-workflow.md).
 *
 * @property {string} message     One-line human summary.
 * @property {string} snippet     Verbatim offending text (may span lines); "" for whole-file findings.
 * @property {number} [startLine] 1-based; omit for whole-file findings.
 * @property {number} [endLine]   1-based, inclusive; defaults to startLine.
 * @property {string} [fingerprint] Filled in by the runner; checks do not set this.
 */
export interface CheckFinding {
  message: string;
  snippet: string;
  startLine?: number;
  endLine?: number;
  fingerprint?: string;
}

/**
 * @typedef {Object} CheckResult
 * @property {CheckStatus} status  - Outcome of the check.
 * @property {string}      [output] - Optional diagnostic text (diff, error message, etc.).
 */

export interface CheckResult {
  status: CheckStatus;
  output?: string;
  extraFiles?: string[];
  findings?: CheckFinding[];
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
  name: string = "Unnamed Check";
  _prdConfig: Record<string, unknown> | null = null;
  #extensions: string[];
  #includePaths: string[];
  #excludePaths: string[];
  #textOnly: boolean;
  #priority: number;

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
  }

  /**
   * @returns {number} Numeric priority (lower runs first).
   */
  get priority(): number {
    return this.#priority;
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
   * @returns {Promise<CheckResult>}
   */
  async lint(_file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    throw new Error("Not implemented: lint");
  }

  /**
   * Fix (in-place modify) a single file.
   * @param {string} _file - Absolute path.
   * @param {Record<string, unknown>} _deps - Resolved dependencies.
   * @returns {Promise<CheckResult>}
   */
  async fix(_file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    throw new Error("Not implemented: fix");
  }

  /**
   * Optional combined lint+fix in a single operation.
   * Checks that can evaluate and fix in one step (e.g. a single AI call)
   * should override this. Return null to signal that the check does not
   * support combined mode — the runner will fall back to fix().
   * @param {string} _file - Absolute path.
   * @param {Record<string, unknown>} _deps - Resolved dependencies.
   * @returns {Promise<CheckResult | null>}
   */
  async lintAndFix(_file: string, _deps: Record<string, unknown>): Promise<CheckResult | null> {
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
    return { name: "BaseCheck", description: "Abstract base class for checks.", options: "extensions, includePaths, excludePaths, textOnly, priority" };
  }
}
