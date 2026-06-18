import fs from "fs/promises";
import { BaseEntry } from "./base-entry.js";

/**
 * Entry representing a single element within a JSON array file.
 * id includes the element index for display; path points to the source file.
 * Virtual entry: readContent slices the array and returns the element in JSON format;
 * writeBack splices the (possibly modified) element back into the array on disk.
 */
export class JsonArrayEntry extends BaseEntry {
  #filePath: string;
  #index: number;
  #element: unknown;

  constructor(filePath: string, index: number, element: unknown) {
    super();
    this.#filePath = filePath;
    this.#index = index;
    this.#element = element;
  }

  override get id(): string {
    return `${this.#filePath}[${this.#index}]`;
  }

  override get path(): string {
    return this.#filePath;
  }

  override get metadata(): object {
    return { index: this.#index, element: this.#element };
  }

  override get isVirtual(): boolean {
    return true;
  }

  override async readContent(): Promise<string> {
    const text = await fs.readFile(this.#filePath, "utf-8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`File ${this.#filePath} is no longer a JSON array`);
    }
    return JSON.stringify(parsed[this.#index], null, 2);
  }

  override async writeBack(content: string): Promise<void> {
    const text = await fs.readFile(this.#filePath, "utf-8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`File ${this.#filePath} is no longer a JSON array`);
    }
    let newElement: unknown;
    try {
      newElement = JSON.parse(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`writeBack content is not valid JSON for ${this.id}: ${msg}`);
    }
    parsed[this.#index] = newElement;
    await fs.writeFile(this.#filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  }
}
