import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

const LOCKFILE_NAME = ".ai-prompt-lock.json";

/**
 * Coerce a value to a string (joining arrays with newlines).
 * Returns undefined for null/undefined.
 */
export const coerce = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.join("\n");
  return String(v);
};

/**
 * Coerce a value to an array.
 * Returns [] for null/undefined, wraps scalars in [].
 */
export const coerceArray = <T>(v: T | T[] | null | undefined): T[] => {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
};

/**
 * Template context for path expansion.
 */
export interface TemplateContext {
  file: string;
  repoRoot: string;
}

/**
 * Standard file-path template placeholders.
 */
export const standardTemplates = (): Record<string, (ctx: Record<string, unknown>) => string> => ({
  "{name_without_ext}": (ctx) => path.basename(String(ctx["file"] || ""), path.extname(String(ctx["file"] || ""))),
  "{name_with_ext}":    (ctx) => path.basename(String(ctx["file"] || "")),
  "{ext}":              (ctx) => path.extname(String(ctx["file"] || "")),
  "{dir}":              (ctx) => path.dirname(path.relative(String(ctx["repoRoot"] || ""), String(ctx["file"] || ""))),
});

/**
 * Expand template placeholders in a path and resolve to absolute.
 * @param {string[]} paths - Template paths.
 * @param {string|null} file - Current file (for template expansion).
 * @param {Function} resolveTemplate - check.resolveTemplate bound method.
 * @param {string} repoRoot - Absolute repo root.
 * @returns {string[]} Absolute resolved paths.
 */
export const resolvePaths = (paths: string[], file: string | null, resolveTemplate: (tmpl: string, ctx: Record<string, unknown>) => string, repoRoot: string): string[] =>
  paths.map((p) => {
    const expanded = file
      ? resolveTemplate(p, { file: path.resolve(file), repoRoot })
      : p;
    const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
    return path.resolve(candidate);
  });

/**
 * Deduplicate an array of paths (resolved to absolute).
 */
export const dedupePaths = (paths: string[]): string[] =>
  Array.from(new Set(paths.map((p) => path.resolve(p))));

/**
 * Read files and build a text context string (for AI prompt checks).
 * @returns {{ value?: string, error?: string }}
 */
export const buildFileContext = async (absPaths: string[], repoRoot: string): Promise<{ value?: string; error?: string }> => {
  const chunks: string[] = [];
  for (const absPath of absPaths) {
    const rel = path.relative(repoRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `path outside repo root is not allowed: ${absPath}` };
    }
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `cannot read context file ${rel}: ${message}` };
    }
    chunks.push(`--- file: ${rel} ---\n${content}\n--- end file: ${rel} ---`);
  }
  return { value: chunks.join("\n\n") };
};

/**
 * Read files and build a { relPath: content } map (for agent checks).
 * @returns {{ value?: Record<string,string>, error?: string }}
 */
export const buildFilesMap = async (absPaths: string[], repoRoot: string): Promise<{ value?: Record<string, string>; error?: string }> => {
  const filesMap: Record<string, string> = {};
  for (const absPath of absPaths) {
    const rel = path.relative(repoRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `path outside repo root is not allowed: ${absPath}` };
    }
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `cannot read file ${rel}: ${message}` };
    }
    filesMap[rel] = content;
  }
  return { value: filesMap };
};

// ── Lock helpers ────────────────────────────────────────────────────

/**
 * Get the absolute path to the lockfile.
 */
export const lockfilePath = (repoRoot: string): string => path.join(repoRoot, LOCKFILE_NAME);

/**
 * Read and parse the lockfile. Returns {} on any error.
 */
export const readLockfile = async (repoRoot: string): Promise<Record<string, Record<string, string | number> | undefined>> => {
  try {
    const content = await fs.readFile(lockfilePath(repoRoot), "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
};

/**
 * Compute a normalized SHA-256 hash for a file (CRLF → LF).
 */
export const getFileHash = async (file: string): Promise<string> => {
  const raw = await fs.readFile(path.resolve(file), "utf-8");
  const normalized = raw.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalized).digest("hex");
};

/**
 * Compute a SHA-256 hash of an arbitrary string.
 */
export const getStringHash = (str: string): string =>
  createHash("sha256").update(str).digest("hex");

/**
 * Check if a lock entry matches the current file content.
 * @param {string} checkName - The check's name (lock namespace).
 * @param {string} relFile - Relative file path (lock key).
 * @param {string} absFile - Absolute file path (for hashing).
 * @param {string} repoRoot - Repo root.
 * @returns {Promise<boolean>}
 */
export const lockMatches = async (checkName: string, relFile: string, absFile: string, repoRoot: string): Promise<boolean> => {
  const lock = await readLockfile(repoRoot);
  const section = lock[checkName];
  if (section == null || typeof section !== "object") return false;
  const entry = section[relFile];

  if (entry == null) return false;
  if (entry === 1) return true;
  if (typeof entry !== "string") return false;

  try {
    const hash = await getFileHash(absFile);
    return hash === entry;
  } catch {
    return false;
  }
};

/**
 * Write a lock entry for a file.
 * @param {string} checkName - The check's name (lock namespace).
 * @param {string} relFile - Relative file path (lock key).
 * @param {string} absFile - Absolute file path (for hashing).
 * @param {string} repoRoot - Repo root.
 * @param {{ lockValue?: number|string }} [opts] - If lockValue is 1/"1", write universal entry.
 */
export const lockWrite = async (checkName: string, relFile: string, absFile: string, repoRoot: string, opts: { lockValue?: number | string } = {}): Promise<void> => {
  const lp = lockfilePath(repoRoot);
  const lock = await readLockfile(repoRoot);
  let section = lock[checkName];
  if (section == null || typeof section !== "object") {
    section = {};
    lock[checkName] = section;
  }

  const writeUniversal = opts.lockValue === 1 || opts.lockValue === "1";
  section[relFile] = writeUniversal ? 1 : await getFileHash(absFile);

  await fs.writeFile(lp, JSON.stringify(lock, null, 2) + "\n", "utf-8");
};

/**
 * Check if a lock entry matches the given content string.
 * Same like lockMatches but takes content directly instead of reading a file.
 */
export const lockMatchesContent = async (checkName: string, key: string, content: string, repoRoot: string): Promise<boolean> => {
  const lock = await readLockfile(repoRoot);
  const section = lock[checkName];
  if (section == null || typeof section !== "object") return false;
  const entry = section[key];
  if (entry == null) return false;
  if (entry === 1) return true;
  if (typeof entry !== "string") return false;
  return getStringHash(content) === entry;
};

/**
 * Write a lock entry for a content string.
 */
export const lockWriteContent = async (checkName: string, key: string, content: string, repoRoot: string, opts: { lockValue?: number | string } = {}): Promise<void> => {
  const lp = lockfilePath(repoRoot);
  const lock = await readLockfile(repoRoot);
  let section = lock[checkName];
  if (section == null || typeof section !== "object") {
    section = {};
    lock[checkName] = section;
  }
  const writeUniversal = opts.lockValue === 1 || opts.lockValue === "1";
  section[key] = writeUniversal ? 1 : getStringHash(content);
  await fs.writeFile(lp, JSON.stringify(lock, null, 2) + "\n", "utf-8");
};
