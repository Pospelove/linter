import { BaseExpander } from "./base-expander.js";
import { FileEntry } from "../entries/file-entry.js";

/**
 * Default expander: yields exactly one FileEntry per file.
 * Preserves the existing per-file check behaviour.
 */
export class FileExpander extends BaseExpander {
  async expand(file) {
    return [new FileEntry(file)];
  }

  static getHelp() {
    return {
      name: "FileExpander",
      description: "Default expander: yields one FileEntry per file (standard per-file behaviour).",
    };
  }
}
