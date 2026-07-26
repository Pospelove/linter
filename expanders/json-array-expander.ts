import fs from "fs/promises";
import { BaseExpander } from "./base-expander.js";
import { JsonArrayEntry } from "../entries/json-array-entry.js";

/**
 * Expander that yields one JsonArrayEntry per element in a JSON array file.
 * If the file does not contain a JSON array, expand() returns an empty array.
 */
export class JsonArrayExpander extends BaseExpander {
  override async expand(file: string): Promise<import("../entries/base-entry.js").BaseEntry[]> {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((element, index) => new JsonArrayEntry(file, index, element));
  }

  static override getHelp() {
    return {
      name: "JsonArrayExpander",
      description: "Yields one entry per element in a JSON array file.",
    };
  }
}
