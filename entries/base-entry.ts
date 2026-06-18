import { promises as fs } from "fs";

/**
 * Represents a single unit of work for a check.
 *
 * By default the unit is a file, but subclasses can represent
 * virtual sub-units: a JSON array element, a binary record, etc.
 *
 * --- TWO INTERFACES ---
 *
 * Entries expose two parallel ways for a check to consume them:
 *
 *   1. File-based  — pass entry.path; the check does its own fs I/O.
 *                    Required path for non-virtual entries.
 *
 *   2. Content-based (string in / string out) — call entry.readContent()
 *                    to get a string slice, then entry.writeBack(newString)
 *                    to splice it back. The check stays oblivious to file
 *                    layout. Virtual entries (isVirtual === true) MUST
 *                    use this path; the runner crashes if the check does
 *                    not declare supportsInMemory.
 *
 * --- ANATOMY ---
 *
 *   entry.id           → "data.json[3]"     shown to the user in output/reports
 *   entry.path         → "/repo/data.json"  passed to check.lint() / check.fix()
 *   entry.sourceFile   → "/repo/data.json"  added to git staging after a fix
 *   entry.metadata     → { index: 3 }       extra context for entry-aware checks
 *   entry.isVirtual    → false / true       false = whole file, true = slice
 *   entry.readContent() → string            slice content as a string
 *   entry.writeBack(s)  → void              splice modified slice back into the file
 *
 * For a plain FileEntry the path/sourceFile collapse to the same absolute
 * path and readContent/writeBack default to reading/writing that file, so
 * existing checks require zero changes.
 *
 * --- SUMMARY ---
 *
 *   Expander  — factory:  file path  →  Entry[]
 *   Entry     — value:    carries id/path/metadata AND knows how to read/write its slice
 */
export class BaseEntry {
  /**
   * Unique identifier for this entry, used in output and reports.
   * For file entries this is the absolute path; for sub-entries it may
   * include a suffix (e.g. "/repo/data.json[3]").
   * @returns {string}
   */
  get id() {
    throw new Error("Not implemented: id");
  }

  /**
   * Absolute path that is passed to check.lint() / check.fix().
   * Returns null for purely virtual entries that have no direct FS path.
   * @returns {string | null}
   */
  get path() {
    return null;
  }

  /**
   * Absolute path of the real file on disk.
   * Used by the runner when adding files to git staging after a fix.
   * Defaults to path.
   * @returns {string | null}
   */
  get sourceFile() {
    return this.path;
  }

  /**
   * Arbitrary metadata — index, offset, key, etc.
   * Subclasses can populate this for checks that are entry-aware.
   * @returns {object}
   */
  get metadata() {
    return {};
  }

  /**
   * Whether this entry is a virtual slice of a larger file (true) or
   * the whole file (false). Virtual entries can ONLY be processed by
   * checks that declare supportsInMemory; the runner aborts otherwise.
   * @returns {boolean}
   */
  get isVirtual() {
    return false;
  }

  /**
   * Read this entry's content as a string.
   * Default: reads the underlying file at this.path. Virtual entries
   * override this to extract just their slice.
   * @returns {Promise<string>}
   */
  async readContent() {
    if (!this.path) throw new Error(`Entry ${this.id} has no path and no readContent override`);
    return fs.readFile(this.path, "utf-8");
  }

  /**
   * Write the given content back to disk as this entry's new value.
   * Default: overwrites this.path with the string verbatim. Virtual
   * entries override this to splice their slice back into the parent file.
   * @param {string} content
   * @returns {Promise<void>}
   */
  async writeBack(content) {
    if (!this.path) throw new Error(`Entry ${this.id} has no path and no writeBack override`);
    await fs.writeFile(this.path, content, "utf-8");
  }
}
