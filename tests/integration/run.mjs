#!/usr/bin/env node
// Integration test runner with snapshot semantics.
//
// For each subdirectory of tests/integration/ that contains a `fixture/` folder,
// the runner:
//   1. Copies the fixture into a fresh temp directory.
//   2. Initializes a throwaway git repo there (so file sources like
//      AllFilesSource can call `git ls-files`).
//   3. Invokes `node dist/linter.mjs <args>` with the temp dir as cwd.
//      Args come from `fixture/args.txt` (whitespace-separated); default is
//      `--lint --mode manual`.
//   4. Normalizes the captured stdout/stderr (temp paths, timing) and compares
//      with the snapshots in `expected/`.
//
// Re-baseline snapshots: UPDATE_SNAPSHOTS=1 node tests/integration/run.mjs
//
// A single test name can be passed in argv to filter:
//   node tests/integration/run.mjs regex-process-env-ban

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LINTER = path.join(REPO_ROOT, "dist", "linter.mjs");
const UPDATE = process.env["UPDATE_SNAPSHOTS"] === "1";
const FILTER = process.argv[2] || null;

if (!fs.existsSync(LINTER)) {
  console.error(`Linter bundle not found at ${LINTER}. Run \`yarn build\` first.`);
  process.exit(1);
}

const copyRecursive = (src, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
};

const runGit = (cwd, args) => {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
};

const initGitRepo = (cwd) => {
  runGit(cwd, ["init", "-q", "-b", "main"]);
  runGit(cwd, ["add", "-A"]);
  runGit(cwd, [
    "-c", "user.email=integration@test.local",
    "-c", "user.name=integration-test",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "init",
  ]);
};

const normalize = (text, tmpDir) => {
  let realTmp = tmpDir;
  try { realTmp = fs.realpathSync(tmpDir); } catch { /* ignore */ }
  const replacements = [
    [new RegExp(escapeRe(tmpDir), "g"), "<TMPDIR>"],
    [new RegExp(escapeRe(realTmp), "g"), "<TMPDIR>"],
    [/Completed in \d+ minutes?, [\d.]+ seconds/g, "Completed in <TIME>"],
    [/Completed in [\d.]+ seconds/g, "Completed in <TIME>"],
  ];
  let out = text;
  for (const [re, sub] of replacements) out = out.replace(re, sub);
  return out;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const readArgs = (fixtureDir) => {
  const argsFile = path.join(fixtureDir, "args.txt");
  if (!fs.existsSync(argsFile)) return ["--lint", "--mode", "manual"];
  return fs.readFileSync(argsFile, "utf-8")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
};

const readSnapshot = (dir, name) => {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "<MISSING>";
};

const writeSnapshot = (dir, name, content) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
};

const printDiff = (label, expected, actual) => {
  console.error(`--- ${label}: expected ---`);
  console.error(expected);
  console.error(`--- ${label}: actual ---`);
  console.error(actual);
  console.error(`--- end ${label} ---`);
};

const findTestCases = () => {
  const all = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(__dirname, d.name))
    .filter((p) => fs.existsSync(path.join(p, "fixture")))
    .sort();
  if (FILTER) return all.filter((p) => path.basename(p) === FILTER);
  return all;
};

const runOne = (testDir) => {
  const name = path.basename(testDir);
  const fixtureDir = path.join(testDir, "fixture");
  const expectedDir = path.join(testDir, "expected");
  const args = readArgs(fixtureDir);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `linter-it-${name}-`));
  try {
    copyRecursive(fixtureDir, tmpDir);
    // args.txt is a runner directive, not a fixture file
    const argsCopy = path.join(tmpDir, "args.txt");
    if (fs.existsSync(argsCopy)) fs.unlinkSync(argsCopy);

    initGitRepo(tmpDir);

    const res = spawnSync("node", [LINTER, ...args], {
      cwd: tmpDir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout = normalize(res.stdout || "", tmpDir);
    const stderr = normalize(res.stderr || "", tmpDir);
    const exitCode = String(res.status ?? "null") + "\n";

    if (UPDATE) {
      writeSnapshot(expectedDir, "stdout.txt", stdout);
      writeSnapshot(expectedDir, "stderr.txt", stderr);
      writeSnapshot(expectedDir, "exit-code.txt", exitCode);
      console.log(`[UPDATE] ${name}`);
      return true;
    }

    const expectedStdout = readSnapshot(expectedDir, "stdout.txt");
    const expectedStderr = readSnapshot(expectedDir, "stderr.txt");
    const expectedExit = readSnapshot(expectedDir, "exit-code.txt");

    const mismatches = [];
    if (stdout !== expectedStdout) mismatches.push("stdout");
    if (stderr !== expectedStderr) mismatches.push("stderr");
    if (exitCode !== expectedExit) mismatches.push("exit-code");

    if (mismatches.length === 0) {
      console.log(`[PASS] ${name}`);
      return true;
    }
    console.error(`[FAIL] ${name} (${mismatches.join(", ")})`);
    if (mismatches.includes("exit-code")) {
      printDiff("exit-code", expectedExit, exitCode);
    }
    if (mismatches.includes("stdout")) {
      printDiff("stdout", expectedStdout, stdout);
    }
    if (mismatches.includes("stderr")) {
      printDiff("stderr", expectedStderr, stderr);
    }
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

const testCases = findTestCases();
if (testCases.length === 0) {
  console.error(FILTER ? `No integration test named "${FILTER}".` : "No integration tests found.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
for (const t of testCases) {
  if (runOne(t)) passed++;
  else failed++;
}
console.log(`\n${passed} passed, ${failed} failed (${testCases.length} total)`);
process.exit(failed > 0 ? 1 : 0);
