/**
 * Base class for all expanders.
 *
 * An expander converts a single file path into one or more BaseEntry objects
 * that represent the units of work for a check.
 *
 * The default expander (FileExpander) produces exactly one FileEntry per file,
 * preserving the current per-file behaviour.
 *
 * Custom expanders can produce multiple entries — e.g. one entry per element
 * in a JSON array, one entry per binary record, etc.
 */
export class BaseExpander {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Expand a file into one or more entries.
   * @param {string} file - Absolute path to the file.
   * @returns {Promise<import("../entries/base-entry.js").BaseEntry[]>}
   */
  async expand(file) {
    throw new Error("Not implemented: expand");
  }

  static getHelp() {
    return {
      name: "BaseExpander",
      description: "Base class for expanders.",
    };
  }
}
