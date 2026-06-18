import { promises as fs } from "fs";
import { BaseEntry } from "./base-entry.js";

/**
 * Entry representing a single element within a JSON array file.
 * id includes the element index for display; path points to the source file.
 * Virtual entry: readContent slices the array and returns the element as JSON;
 * writeBack splices the (possibly modified) element back into the array on disk.
 */
export class JsonArrayEntry extends BaseEntry {
  #filePath;
  #index;
  #element;

  constructor(filePath, index, element) {
    super();
    this.#filePath = filePath;
    this.#index = index;
    this.#element = element;
  }

  get id() {
    return `${this.#filePath}[${this.#index}]`;
  }

  get path() {
    return this.#filePath;
  }

  get metadata() {
    return { index: this.#index, element: this.#element };
  }

  get isVirtual() {
    return true;
  }

  async readContent() {
    const text = await fs.readFile(this.#filePath, "utf-8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`File ${this.#filePath} is no longer a JSON array`);
    }
    return JSON.stringify(parsed[this.#index], null, 2);
  }

  async writeBack(content) {
    const text = await fs.readFile(this.#filePath, "utf-8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`File ${this.#filePath} is no longer a JSON array`);
    }
    let newElement;
    try {
      newElement = JSON.parse(content);
    } catch (err) {
      throw new Error(`writeBack content is not valid JSON for ${this.id}: ${err.message}`);
    }
    parsed[this.#index] = newElement;
    await fs.writeFile(this.#filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  }
}
