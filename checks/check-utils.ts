import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";

const LOCKFILE_NAME = ".ai-prompt-lock.json";

/**
 * Coerce a value to a string (joining arrays with newlines).
 * Returns undefined for null/undefined.
 */
export const coerce = (v) => (v == null ? undefined : Array.isArray(v) ? v.join("\n") : v);

/**
 * Coerce a value to an array.
 * Returns [] for null/undefined, wraps scalars in [].
 */
export const coerceArray = (v) => {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
};

/**
 * Standard file-path template placeholders.
 */
export const standardTemplates = () => ({
  "{name_without_ext}": (ctx) => path.basename(ctx.file, path.extname(ctx.file)),
  "{name_with_ext}":    (ctx) => path.basename(ctx.file),
  "{ext}":              (ctx) => path.extname(ctx.file),
  "{dir}":              (ctx) => path.dirname(path.relative(ctx.repoRoot, ctx.file)),
});

/**
 * Expand template placeholders in a path and resolve to absolute.
 * @param {string[]} paths - Template paths.
 * @param {string|null} file - Current file (for template expansion).
 * @param {Function} resolveTemplate - check.resolveTemplate bound method.
 * @param {string} repoRoot - Absolute repo root.
 * @returns {string[]} Absolute resolved paths.
 */
export const resolvePaths = (paths, file, resolveTemplate, repoRoot) =>
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
export const dedupePaths = (paths) =>
  Array.from(new Set(paths.map((p) => path.resolve(p))));

/**
 * Read files and build a text context string (for AI prompt checks).
 * @returns {{ value?: string, error?: string }}
 */
export const buildFileContext = async (absPaths, repoRoot) => {
  const chunks = [];
  for (const absPath of absPaths) {
    const rel = path.relative(repoRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `path outside repo root is not allowed: ${absPath}` };
    }
    let content;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      return { error: `cannot read context file ${rel}: ${err.message}` };
    }
    chunks.push(`--- file: ${rel} ---\n${content}\n--- end file: ${rel} ---`);
  }
  return { value: chunks.join("\n\n") };
};

/**
 * Read files and build a { relPath: content } map (for agent checks).
 * @returns {{ value?: Record<string,string>, error?: string }}
 */
export const buildFilesMap = async (absPaths, repoRoot) => {
  const filesMap = {};
  for (const absPath of absPaths) {
    const rel = path.relative(repoRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `path outside repo root is not allowed: ${absPath}` };
    }
    let content;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      return { error: `cannot read file ${rel}: ${err.message}` };
    }
    filesMap[rel] = content;
  }
  return { value: filesMap };
};

// ── Lock helpers ────────────────────────────────────────────────────

/**
 * Get the absolute path to the lockfile.
 */
export const lockfilePath = (repoRoot) => path.join(repoRoot, LOCKFILE_NAME);

/**
 * Read and parse the lockfile. Returns {} on any error.
 */
export const readLockfile = async (repoRoot) => {
  try {
    return JSON.parse(await fs.readFile(lockfilePath(repoRoot), "utf-8"));
  } catch {
    return {};
  }
};

/**
 * Compute a normalized SHA-256 hash for a file (CRLF → LF).
 */
export const getFileHash = async (file) => {
  const raw = await fs.readFile(path.resolve(file), "utf-8");
  const normalized = raw.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalized).digest("hex");
};

/**
 * Compute a SHA-256 hash of an arbitrary string.
 */
export const getStringHash = (str) =>
  createHash("sha256").update(str).digest("hex");

/**
 * Check if a lock entry matches the current file content.
 * @param {string} checkName - The check's name (lock namespace).
 * @param {string} relFile - Relative file path (lock key).
 * @param {string} absFile - Absolute file path (for hashing).
 * @param {string} repoRoot - Repo root.
 * @returns {Promise<boolean>}
 */
export const lockMatches = async (checkName, relFile, absFile, repoRoot) => {
  const lock = await readLockfile(repoRoot);
  const entry = lock[checkName]?.[relFile];

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
export const lockWrite = async (checkName, relFile, absFile, repoRoot, opts = {}) => {
  const lp = lockfilePath(repoRoot);
  const lock = await readLockfile(repoRoot);
  if (!lock[checkName]) lock[checkName] = {};

  const writeUniversal = opts.lockValue === 1 || opts.lockValue === "1";
  lock[checkName][relFile] = writeUniversal ? 1 : await getFileHash(absFile);

  await fs.writeFile(lp, JSON.stringify(lock, null, 2) + "\n", "utf-8");
};

/**
 * Check if a lock entry matches the given content string.
 * Same as lockMatches but takes content directly instead of reading a file.
 */
export const lockMatchesContent = async (checkName, key, content, repoRoot) => {
  const lock = await readLockfile(repoRoot);
  const entry = lock[checkName]?.[key];
  if (entry == null) return false;
  if (entry === 1) return true;
  if (typeof entry !== "string") return false;
  return getStringHash(content) === entry;
};

/**
 * Write a lock entry for a content string.
 */
export const lockWriteContent = async (checkName, key, content, repoRoot, opts = {}) => {
  const lp = lockfilePath(repoRoot);
  const lock = await readLockfile(repoRoot);
  if (!lock[checkName]) lock[checkName] = {};
  const writeUniversal = opts.lockValue === 1 || opts.lockValue === "1";
  lock[checkName][key] = writeUniversal ? 1 : getStringHash(content);
  await fs.writeFile(lp, JSON.stringify(lock, null, 2) + "\n", "utf-8");
};
