import fs from "fs/promises";
import iconv from "iconv-lite";
import { BaseCheck } from "./base-check.js";

const SUPPORTED = new Set(["utf-8", "cp1251", "ascii"]);

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff]);

function hasBom(buf) {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) return "UTF-8";
  if (buf.length >= 2 && buf.subarray(0, 2).equals(UTF16_LE_BOM)) return "UTF-16 LE";
  if (buf.length >= 2 && buf.subarray(0, 2).equals(UTF16_BE_BOM)) return "UTF-16 BE";
  return null;
}

function stripBom(buf) {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) return buf.subarray(3);
  return buf;
}

function isAsciiOnly(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) return false;
  }
  return true;
}

function isValidUtf8(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function normalizeEncoding(name) {
  if (typeof name !== "string") return null;
  const k = name.toLowerCase().replace(/_/g, "-");
  if (k === "utf8" || k === "utf-8") return "utf-8";
  if (k === "cp1251" || k === "windows-1251" || k === "win1251") return "cp1251";
  if (k === "ascii" || k === "us-ascii") return "ascii";
  return null;
}

export class EncodingCheck extends BaseCheck {
  #encoding;

  constructor(repoRoot, options = {}) {
    super(repoRoot, options);
    const declared = normalizeEncoding(options.encoding);
    if (!declared || !SUPPORTED.has(declared)) {
      throw new Error(`EncodingCheck: option "encoding" must be "utf-8", "cp1251", or "ascii", got ${JSON.stringify(options.encoding)}`);
    }
    this.#encoding = declared;
  }

  get name() {
    return `encoding(${this.#encoding})`;
  }

  async lint(file) {
    try {
      const buf = await fs.readFile(file);
      const bom = hasBom(buf);
      if (bom) {
        return { status: "fail", output: `file starts with a ${bom} BOM; BOMs are not allowed` };
      }
      if (isAsciiOnly(buf)) {
        return { status: "pass" };
      }
      if (this.#encoding === "ascii") {
        return { status: "fail", output: "file contains non-ASCII bytes (>= 0x80)" };
      }
      const valid = isValidUtf8(buf);
      if (this.#encoding === "utf-8") {
        return valid ? { status: "pass" } : { status: "fail", output: "file is not valid UTF-8 (looks like CP1251 or another single-byte encoding)" };
      }
      return valid ? { status: "fail", output: "file decodes as UTF-8 but CP1251 is required" } : { status: "pass" };
    } catch (err) {
      return { status: "error", output: err.message };
    }
  }

  async fix(file) {
    try {
      const original = await fs.readFile(file);
      const stripped = stripBom(original);
      const hadBom = stripped.length !== original.length;

      if (isAsciiOnly(stripped)) {
        if (hadBom) {
          await fs.writeFile(file, stripped);
          return { status: "fixed" };
        }
        return { status: "pass" };
      }

      if (this.#encoding === "ascii") {
        if (hadBom) {
          await fs.writeFile(file, stripped);
          return { status: "fail", output: "stripped BOM, but file still contains non-ASCII bytes that cannot be auto-fixed" };
        }
        return { status: "fail", output: "file contains non-ASCII bytes (>= 0x80) that cannot be auto-fixed" };
      }

      const sourceIsUtf8 = isValidUtf8(stripped);
      const sourceEncoding = sourceIsUtf8 ? "utf-8" : "cp1251";

      if (sourceEncoding === this.#encoding) {
        if (hadBom) {
          await fs.writeFile(file, stripped);
          return { status: "fixed" };
        }
        return { status: "pass" };
      }

      const text = iconv.decode(stripped, sourceEncoding);
      const out = iconv.encode(text, this.#encoding);
      await fs.writeFile(file, out);
      return { status: "fixed" };
    } catch (err) {
      return { status: "error", output: err.message };
    }
  }

  static getHelp() {
    return {
      name: "EncodingCheck",
      description: "Asserts that files use a specific text encoding (utf-8, cp1251, or ascii). Bans BOMs. ASCII-only files always pass. Autofix transcodes between utf-8 and cp1251 via iconv-lite; for ascii mode, fix only strips BOM.",
      options: 'encoding — required, "utf-8", "cp1251", or "ascii"; plus base options (extensions, includePaths, excludePaths, textOnly, priority).',
    };
  }
}
