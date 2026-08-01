#!/usr/bin/env node
// Integration runner for code-defined tests (`*.test.mjs`). Each module exports
// a definition created with defineIntegrationTest() from ./test-api.mjs.
//
// Definitions express only the project files and the observable CLI contract.
// Keeping process execution here ensures every test still gets a fresh Git repo,
// matching the environment the linter expects. The former fixture-directory
// format is intentionally unsupported: one test representation avoids a split
// suite with subtly different semantics.
//
// A single test name can be passed in argv to filter:
//   node tests/integration/run.mjs config-findings-per-story-invalid

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LINTER = path.join(REPO_ROOT, "dist", "linter.mjs");
const FILTER = process.argv[2] || null;

if (!fs.existsSync(LINTER)) {
  console.error(`Linter bundle not found at ${LINTER}. Run \`yarn build\` first.`);
  process.exit(1);
}

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
    [new RegExp(`node ${escapeRe(LINTER)}`, "g"), "node <LINTER>"],
    [/Completed in \d+ minutes?, [\d.]+ seconds/g, "Completed in <TIME>"],
    [/Completed in [\d.]+ seconds/g, "Completed in <TIME>"],
  ];
  let out = text;
  for (const [re, sub] of replacements) out = out.replace(re, sub);
  // Snapshots are source-controlled text, so compare platform-neutral output.
  // Fixture contents themselves are left untouched; checks can still exercise
  // CRLF input deliberately.
  return out
    .replaceAll("\r\n", "\n")
    .replaceAll("<TMPDIR>\\", "<TMPDIR>/")
    // A temp Git repo makes the bundled linter look globally installed. Its
    // generated PRD command is equivalent to the runner's normalized command.
    .replaceAll("skymp-linter", "node <LINTER>");
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const printDiff = (label, expected, actual) => {
  console.error(`--- ${label}: expected ---`);
  console.error(expected);
  console.error(`--- ${label}: actual ---`);
  console.error(actual);
  console.error(`--- end ${label} ---`);
};

const findTestCases = async () => {
  const modules = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(__dirname, entry.name))
    .sort();
  const cases = await Promise.all(modules.map(async (modulePath) => {
    // Convert the Windows path explicitly: import() expects a URL, not a native path.
    const module = await import(pathToFileURL(modulePath).href);
    if (!module.default || typeof module.default.name !== "string") {
      throw new Error(`${path.basename(modulePath)} must default-export defineIntegrationTest(...)`);
    }
    return module.default;
  }));
  return FILTER ? cases.filter((test) => test.name === FILTER) : cases;
};

const writeFixtureFiles = (tmpDir, files) => {
  for (const [relativePath, content] of files) {
    const destination = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
};

const runOne = (test) => {
  const {
    name, files, args, expectedStdout, expectedStderr, expectedExitCode, expectedFiles,
  } = test;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `linter-it-${name}-`));
  try {
    writeFixtureFiles(tmpDir, files);
    initGitRepo(tmpDir);

    const res = spawnSync("node", [LINTER, ...args], {
      cwd: tmpDir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdout = normalize(res.stdout || "", tmpDir);
    const stderr = normalize(res.stderr || "", tmpDir);
    // Apply the same portability rules to declared expectations. This keeps
    // snapshots stable across Git line-ending settings without changing a
    // fixture file's deliberate byte-level contents.
    const normalizedExpectedStdout = normalize(expectedStdout, tmpDir);
    const normalizedExpectedStderr = normalize(expectedStderr, tmpDir);
    const generatedFiles = new Map();
    const normalizedExpectedFiles = new Map();
    for (const [relativePath, expectedContent] of expectedFiles) {
      const generatedPath = path.join(tmpDir, relativePath);
      generatedFiles.set(relativePath, fs.existsSync(generatedPath)
        ? normalize(fs.readFileSync(generatedPath, "utf-8"), tmpDir)
        : "<MISSING>\n");
      normalizedExpectedFiles.set(relativePath, normalize(expectedContent, tmpDir));
    }
    const mismatches = [];
    if (stdout !== normalizedExpectedStdout) mismatches.push("stdout");
    if (stderr !== normalizedExpectedStderr) mismatches.push("stderr");
    if (res.status !== expectedExitCode) mismatches.push("exit-code");
    for (const [relativePath, actualContent] of generatedFiles) {
      if (actualContent !== normalizedExpectedFiles.get(relativePath)) mismatches.push(relativePath);
    }

    if (mismatches.length === 0) {
      console.log(`[PASS] ${name}`);
      return true;
    }
    console.error(`[FAIL] ${name} (${mismatches.join(", ")})`);
    if (mismatches.includes("exit-code")) {
      printDiff("exit-code", String(expectedExitCode), String(res.status));
    }
    if (mismatches.includes("stdout")) {
      printDiff("stdout", normalizedExpectedStdout, stdout);
    }
    if (mismatches.includes("stderr")) {
      printDiff("stderr", normalizedExpectedStderr, stderr);
    }
    for (const [relativePath, actualContent] of generatedFiles) {
      if (mismatches.includes(relativePath)) {
        printDiff(relativePath, normalizedExpectedFiles.get(relativePath), actualContent);
      }
    }
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

const testCases = await findTestCases();
if (testCases.length === 0) {
  console.error(FILTER ? `No integration test named "${FILTER}".` : "No *.test.mjs integration tests found.");
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
