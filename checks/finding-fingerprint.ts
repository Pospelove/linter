import path from "path";

export interface FingerprintPayload {
  check: string;
  file: string;
  snippet: string;
}

/**
 * Derives a deterministic fingerprint for a finding.
 * Spec: docs/per-finding-workflow.md "Fingerprint" (lines 122-184).
 *
 * @param checkName The name of the check.
 * @param absoluteFilePath Absolute path to the file.
 * @param snippet Verbatim offending text.
 * @param repoRoot Absolute path to the repository root.
 * @returns base64url encoded JSON string of { check, file, snippet }.
 */
export function deriveFingerprint(
  checkName: string,
  absoluteFilePath: string,
  snippet: string,
  repoRoot: string
): string {
  // 1. Normalize the snippet: trim and replace all whitespace sequences with a single space.
  const normalizedSnippet = snippet.trim().replace(/\s+/g, " ");

  // 2. Normalize the file path: relative to repo root, forward slashes.
  // Reject UNC / \\?\ / drive-relative paths.
  if (absoluteFilePath.startsWith("\\\\") || /^[a-zA-Z]:(?!\\|\/)/.test(absoluteFilePath)) {
    throw new Error(`Non-portable path detected in fingerprint derivation: ${absoluteFilePath}`);
  }

  const relativeFile = path.relative(repoRoot, absoluteFilePath).replace(/\\/g, "/");

  // 3. Construct the payload in fixed alphabetical key order.
  const payload: FingerprintPayload = {
    check: checkName,
    file: relativeFile,
    snippet: normalizedSnippet,
  };

  // 4. Encode to be base64url(JSON.stringify(payload)).
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json).toString("base64");

  // base64url is base64 with: + -> -, / -> _, and padding (=) removed.
  return base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
