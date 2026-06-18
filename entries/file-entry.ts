import { BaseEntry } from "./base-entry.js";

/**
 * Default entry: wraps a single absolute file path.
 * id, path, and sourceFile all return the same value.
 */
export class FileEntry extends BaseEntry {
  #filePath: string;

  constructor(filePath: string) {
    super();
    this.#filePath = filePath;
  }

  override get id(): string {
    return this.#filePath;
  }

  override get path(): string {
    return this.#filePath;
  }
}
