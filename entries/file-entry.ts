import { BaseEntry } from "./base-entry.js";

/**
 * Default entry: wraps a single absolute file path.
 * id, path, and sourceFile all return the same value.
 */
export class FileEntry extends BaseEntry {
  #filePath;

  constructor(filePath) {
    super();
    this.#filePath = filePath;
  }

  get id() {
    return this.#filePath;
  }

  get path() {
    return this.#filePath;
  }
}
