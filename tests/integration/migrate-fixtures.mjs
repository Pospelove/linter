#!/usr/bin/env node
// One-time migration from the former directory fixtures to code-defined tests.
// It reads and writes only tests/integration, emits literal strings so output
// snapshots remain exact, then removes each legacy case only after its module
// has been created. Keep this script until the migrated suite has settled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const integrationDir = path.dirname(__filename);

const readText = (filePath) => fs.readFileSync(filePath, "utf-8");

const readFiles = (root) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push([path.relative(root, absolute).replaceAll("\\", "/"), readText(absolute)]);
    }
  };
  visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
};

const readArgs = (fixtureDir) => {
  const argsPath = path.join(fixtureDir, "args.txt");
  if (!fs.existsSync(argsPath)) return ["--lint", "--mode", "manual"];
  return readText(argsPath).trim().split(/\s+/).filter(Boolean);
};

const quote = (value) => JSON.stringify(value);
const formatJsonObject = (value, indent = "  ") => {
  const lines = JSON.stringify(value, null, 2).split("\n");
  return lines.map((line, index) => {
    if (index === 0) return line;
    return `${indent}${index === lines.length - 1 ? "" : "  "}${line}`;
  }).join("\n");
};

const preserveInputLineEndings = (testName, relativePath) =>
  testName === "crlf-per-finding-show-all" && relativePath === "src/a.txt";

const portableText = (testName, relativePath, content) =>
  preserveInputLineEndings(testName, relativePath) ? content : content.replaceAll("\r\n", "\n");

const migrate = (testDir) => {
  const name = path.basename(testDir);
  const fixtureDir = path.join(testDir, "fixture");
  const expectedDir = path.join(testDir, "expected");
  const outputPath = path.join(integrationDir, `${name}.test.mjs`);
  if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);

  const fixtureFiles = readFiles(fixtureDir)
    .filter(([relativePath]) => relativePath !== "args.txt" && relativePath !== "extra-snapshots.txt");
  const artifactNamesPath = path.join(fixtureDir, "extra-snapshots.txt");
  const artifactNames = fs.existsSync(artifactNamesPath)
    ? readText(artifactNamesPath).trim().split("\n").filter(Boolean)
    : [];
  const calls = [];
  for (const [relativePath, content] of fixtureFiles) {
    const fixtureContent = portableText(name, relativePath, content);
    if (relativePath === "linter-config.json") {
      calls.push(`addFixtureFile(${quote(relativePath)}, ${formatJsonObject(JSON.parse(fixtureContent))})`);
    } else {
      calls.push(`addFixtureFile(${quote(relativePath)}, ${quote(fixtureContent)})`);
    }
  }
  calls.push(`setArgs(${readArgs(fixtureDir).map(quote).join(", ")})`);
  calls.push(`expectStdout(${quote(portableText(name, "stdout.txt", readText(path.join(expectedDir, "stdout.txt"))))})`);
  calls.push(`expectStderr(${quote(portableText(name, "stderr.txt", readText(path.join(expectedDir, "stderr.txt"))))})`);
  calls.push(`expectExitCode(${Number(readText(path.join(expectedDir, "exit-code.txt")).trim())})`);
  for (const artifactName of artifactNames) {
    calls.push(`expectGeneratedFile(${quote(artifactName)}, ${quote(portableText(name, artifactName, readText(path.join(expectedDir, artifactName))))})`);
  }

  const source = [
    'import { defineIntegrationTest } from "./test-api.mjs";',
    "",
    `export default defineIntegrationTest(${quote(name)}, (test) => {`,
    `  test.${calls.join("\n    .")};`,
    "});",
    "",
  ].join("\n");
  fs.writeFileSync(outputPath, source);
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(`[MIGRATED] ${name}`);
};

const testDirs = fs.readdirSync(integrationDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(integrationDir, entry.name))
  .filter((dir) => fs.existsSync(path.join(dir, "fixture")))
  .sort();

for (const testDir of testDirs) migrate(testDir);
console.log(`Migrated ${testDirs.length} integration tests.`);

// A migration can be run after the fixture directories were already removed.
// Convert generated configuration strings too, so the resulting modules remain
// pleasant to edit by hand.
const configCall = /addFixtureFile\("linter-config\.json", ("(?:\\.|[^"\\])*")\)/;
const reindentConfigObject = (source) => {
  const startMarker = 'test.addFixtureFile("linter-config.json", {\n';
  const start = source.indexOf(startMarker);
  if (start === -1) return source;
  const bodyStart = start + startMarker.length;
  const end = source.indexOf("\n})", bodyStart);
  if (end === -1) throw new Error("Could not find the end of linter-config.json fixture");
  const lines = source.slice(bodyStart, end).split("\n");
  const indentation = lines
    .filter((line) => line.trim())
    .map((line) => line.length - line.trimStart().length);
  const minimum = Math.min(...indentation);
  const hasIndentedClosing = source.startsWith("\n  })", end);
  if (minimum === 4 && hasIndentedClosing) return source;
  const shift = 4 - minimum;
  const body = lines.map((line) => line.trim() ? `${" ".repeat(shift)}${line}` : line).join("\n");
  return `${source.slice(0, bodyStart)}${body}\n  })${source.slice(end + 3)}`;
};
let converted = 0;
for (const entry of fs.readdirSync(integrationDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
  const modulePath = path.join(integrationDir, entry.name);
  const source = readText(modulePath);
  const stringConverted = source.replace(configCall, (_whole, stringLiteral) => {
    const configText = JSON.parse(stringLiteral);
    const config = JSON.parse(configText);
    return `addFixtureFile("linter-config.json", ${formatJsonObject(config)})`;
  });
  const updated = reindentConfigObject(stringConverted);
  if (updated !== source) {
    fs.writeFileSync(modulePath, updated);
    converted++;
  }
}
console.log(`Converted ${converted} configuration fixture(s) to objects.`);
