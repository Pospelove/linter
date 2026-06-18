import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync, execSync } from "child_process";
import pLimit from "p-limit";

import { ensureCleanExit } from "./util.js";
import { builtinRegistry, builtinChecks, builtinFileSources, builtinExpanders } from "./registry.js";
import { CompositeCheck } from "./checks/composite-check.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* global __LINTER_VERSION__, __LINTER_COMMIT__ */
const LINTER_VERSION = typeof __LINTER_VERSION__ !== "undefined" ? __LINTER_VERSION__ : "dev";
const LINTER_COMMIT = typeof __LINTER_COMMIT__ !== "undefined" ? __LINTER_COMMIT__ : "unknown";

const UPGRADE_URL = "https://raw.githubusercontent.com/skyrim-multiplayer/linter/main/dist/linter.mjs";
const YARN_INSTALL_SPEC = "https://github.com/skyrim-multiplayer/linter#main";

const getRepoRoot = () => {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) {
    console.warn("Warning: not a git repository, using cwd as repo root");
    return process.cwd();
  }
  return result.stdout.trim();
};

const REPO_ROOT = getRepoRoot();

/**
 * Resolve a class from config entry by looking up "export" in the built-in registry.
 */
const resolveClass = async (entry) => {
  const exportName = entry.export;
  const Cls = builtinRegistry[exportName];
  if (!Cls) {
    throw new Error(
      `Export "${exportName}" not found in built-in registry. ` +
      `Available: ${Object.keys(builtinRegistry).join(", ")}.`
    );
  }
  return Cls;
};

/**
 * Load config, instantiate file source and checks for the given mode.
 */
const loadConfig = async (mode) => {
  const configPath = path.join(REPO_ROOT, "linter-config.json");
  const config = JSON.parse(await fs.promises.readFile(configPath, "utf-8"));

  // --- tools directory (configurable, defaults to <repoRoot>/tools) ---
  const toolsDir = config.toolsDir
    ? path.resolve(REPO_ROOT, config.toolsDir)
    : path.join(REPO_ROOT, "tools");

  // --- file source ---
  const modeConfig = config.modes[mode];
  if (!modeConfig) {
    throw new Error(`Unknown mode "${mode}". Available: ${Object.keys(config.modes).join(", ")}`);
  }
  const srcEntry = modeConfig.fileSource;
  const SrcClass = await resolveClass(srcEntry);
  const fileSource = new SrcClass(REPO_ROOT, srcEntry.options || {});

  // --- checks ---
  const checks = [];
  for (const entry of config.checks) {
    if (!entry.modes.includes(mode)) {
      console.log(`Skipping check "${entry.name}": not enabled for mode "${mode}"`);
      continue;
    }
    const CheckClass = await resolveClass(entry);
    let check = new CheckClass(REPO_ROOT, entry.options || {});
    if (entry.fixWith) {
      const FixClass = await resolveClass(entry.fixWith);
      const fixer = new FixClass(REPO_ROOT, { ...entry.options, ...entry.fixWith.options });
      check = new CompositeCheck(check, fixer);
    }
    // Assign config name as own property so it can be filtered by --checks
    Object.defineProperty(check, "name", { value: entry.name, configurable: true, writable: true });
    check._prdConfig = entry.prd || null;
    if (entry.expander) {
      const ExpanderClass = await resolveClass(entry.expander);
      const expander = new ExpanderClass(entry.expander.options || {});
      check.setExpander(expander);
    }
    checks.push(check);
  }

  const prdConfig = config.prd || {};

  return { fileSource, checks, toolsDir, prdConfig, checkEntries: config.checks };
};

/**
 * Make path relative to REPO_ROOT for compact output.
 */
const relPath = (file) => {
  if (file.startsWith(REPO_ROOT + path.sep)) {
    return file.slice(REPO_ROOT.length + 1);
  }
  return file;
};

/**
 * Format all check results for a single file into log lines.
 *
 * If every check passed  → single line: [PASS] rel/path [Check1, Check2, ...]
 * If every check fixed   → single line: [FIXED] rel/path [Check1, Check2, ...]
 * If mixed pass+fixed    → single line: [OK] rel/path [passed: A, B | fixed: C]
 * Otherwise              → one line per failed/errored check with details.
 *
 * @param {{ res: CheckResult, checkName: string }[]} results
 * @param {string} file  Absolute path.
 * @returns {{ lines: string[], isFail: boolean, stats: { pass: number, fixed: number, fail: number, error: number } }}
 */
const formatFileResults = (results, file) => {
  const rel = relPath(file);
  const lines = [];
  let isFail = false;
  const stats = { pass: 0, fixed: 0, fail: 0, error: 0 };

  const passed = [];
  const fixed = [];
  const bad = [];

  for (const { res, checkName } of results) {
    switch (res.status) {
      case "pass":
        passed.push(checkName);
        stats.pass++;
        break;
      case "fixed":
        fixed.push(checkName);
        stats.fixed++;
        break;
      case "fail":
        bad.push({ res, checkName });
        stats.fail++;
        break;
      case "error":
      default:
        bad.push({ res, checkName });
        stats.error++;
        break;
    }
  }

  if (bad.length === 0) {
    // All good — compact summary
    if (fixed.length === 0) {
      lines.push(`[PASS] ${rel} [${passed.join(", ")}]`);
    } else if (passed.length === 0) {
      lines.push(`[FIXED] ${rel} [${fixed.join(", ")}]`);
    } else {
      const parts = [];
      if (passed.length) parts.push(`passed: ${passed.join(", ")}`);
      if (fixed.length) parts.push(`fixed: ${fixed.join(", ")}`);
      lines.push(`[OK] ${rel} [${parts.join(" | ")}]`);
    }
  } else {
    // Some failures — print each result individually
    isFail = true;
    for (const name of passed) {
      lines.push(`[PASS] ${rel} [${name}]`);
    }
    for (const name of fixed) {
      lines.push(`[FIXED] ${rel} [${name}]`);
    }
    for (const { res, checkName } of bad) {
      const status = res.status === "fail" ? "FAIL" : res.status === "error" ? "ERROR" : "UNKNOWN";
      lines.push(`[${status}] ${rel} [${checkName}]`);
      if (res.output) lines.push(`  ${res.output}`);
    }
  }

  return { lines, isFail, stats };
};

/**
 * Refuse virtual entries against checks that don't speak the in-memory contract.
 * A virtual entry (e.g. one element of a JSON array) cannot be processed by a
 * check that does its own raw file I/O — that would corrupt the surrounding file.
 */
const assertEntrySupported = (check, entry) => {
  if (entry.isVirtual && !check.supportsInMemory) {
    throw new Error(
      `Check "${check.name}" does not support in-memory entries (supportsInMemory === false), ` +
      `but its expander produced a virtual entry "${entry.id}". ` +
      `Either use a check that implements the *InMemory interface, or drop the expander for this check.`
    );
  }
};

/**
 * Run a single (check, entry) pair in lint-only mode.
 * Routes to lintInMemory when the check supports it; otherwise falls back to file-based lint.
 */
const runEntryLint = async (check, entry, fallbackFile, deps) => {
  assertEntrySupported(check, entry);
  if (check.supportsInMemory) {
    const content = await entry.readContent();
    return check.lintInMemory(content, deps, entry);
  }
  return check.lint(entry.path ?? fallbackFile, deps, entry);
};

/**
 * Run a single (check, entry) pair in fix mode.
 * Routes to lintAndFixInMemory/fixInMemory when supported, writing the result back via entry.writeBack.
 * Otherwise falls back to file-based lintAndFix/fix.
 */
const runEntryFix = async (check, entry, fallbackFile, deps) => {
  assertEntrySupported(check, entry);
  if (check.supportsInMemory) {
    const content = await entry.readContent();
    const res =
      (typeof check.lintAndFixInMemory === "function" && await check.lintAndFixInMemory(content, deps, entry)) ||
      await check.fixInMemory(content, deps, entry);
    if (res && res.status === "fixed" && typeof res.content === "string") {
      await entry.writeBack(res.content);
    }
    return res;
  }
  const entryPath = entry.path ?? fallbackFile;
  return (typeof check.lintAndFix === "function" && await check.lintAndFix(entryPath, deps, entry)) ||
    check.fix(entryPath, deps, entry);
};

/**
 * Core: Run checks (lint or fix) on given files.
 *
 * Lint mode:  all (check, file) pairs run in parallel.
 * Fix mode:   one file at a time (sequential) to avoid races on shared files.
 *
 * Returns { extraFiles, failed, failedPairs } instead of calling process.exit(1).
 * failedPairs: Array<{ file: string, checkName: string }>
 */
const runChecks = async (files, checks, { lintOnly = false, verbose = false, ...deps }) => {

  const extraFiles = new Set();
  const failedPairs = [];

  // Group checks by file instead of a sequential flat array
  const fileToChecks = new Map();
  let totalChecks = 0;

  for (const check of checks) {
    if (!check.checkDeps(deps)) {
      console.warn(`Skipped ${check.name}: failed deps check`);
      continue;
    }
    for (const file of files) {
      if (await check.appliesTo(file)) {
        if (!fileToChecks.has(file)) {
          fileToChecks.set(file, []);
        }
        fileToChecks.get(file).push(check);
        totalChecks++;
      }
    }
  }

  const groupedWork = Array.from(fileToChecks.entries()).map(([file, fileChecks]) => {
    fileChecks.sort((a, b) => a.priority - b.priority);
    return { file, checks: fileChecks };
  });

  if (groupedWork.length === 0) {
    console.log("No matching files found for checks.");
    return { extraFiles: new Set(), failed: false, failedPairs: [] };
  }

  console.log(`${lintOnly ? "Linting" : "Fixing"} ${totalChecks} check(s) across ${groupedWork.length} file(s)...`);

  let fail = false;
  const counters = { pass: 0, fixed: 0, fail: 0, error: 0 };

  if (lintOnly) {
    // Parallel lint: controlled by p-limit per file
    const limit = pLimit(10); // reasonable default for lints
    await Promise.all(
      groupedWork.map(({ file, checks }) =>
        limit(async () => {
          // For each check, expand the file into entries, then lint each entry
          const rawResults = await Promise.all(
            checks.map(async (check) => {
              const entries = await check.expand(file);
              return Promise.all(entries.map(async (entry) => {
                try {
                  const res = await runEntryLint(check, entry, file, deps);
                  return { res, checkName: check.name, entryId: entry.id };
                } catch (err) {
                  return { res: { status: "error", output: err.message }, checkName: check.name, entryId: entry.id };
                }
              }));
            })
          );
          const results = rawResults.flat();

          // Group results by entryId and format each group independently
          const byEntry = new Map();
          for (const r of results) {
            if (!byEntry.has(r.entryId)) byEntry.set(r.entryId, []);
            byEntry.get(r.entryId).push(r);
          }
          for (const [entryId, entryResults] of byEntry) {
            const { lines, isFail, stats } = formatFileResults(entryResults, entryId);
            counters.pass += stats.pass;
            counters.fixed += stats.fixed;
            counters.fail += stats.fail;
            counters.error += stats.error;
            if (lines.length > 0) {
              if (isFail) {
                console.error(lines.join("\n"));
              } else if (verbose) {
                console.log(lines.join("\n"));
              }
            }
            if (isFail) {
              fail = true;
              for (const { res, checkName } of entryResults) {
                if (res.status === "fail" || res.status === "error") {
                  failedPairs.push({ file: entryId, checkName });
                }
              }
            }
          }
        })
      )
    );
  } else {
    // Sequential fix: file by file, check by check to avoid file races
    for (const { file, checks } of groupedWork) {
      const fileResults = [];

      for (const check of checks) {
        const entries = await check.expand(file);
        for (const entry of entries) {
          try {
            const res = await runEntryFix(check, entry, file, deps);
            if (res.extraFiles) res.extraFiles.forEach((f) => extraFiles.add(f));
            fileResults.push({ res, checkName: check.name, entryId: entry.id });
          } catch (err) {
            fileResults.push({ res: { status: "error", output: err.message }, checkName: check.name, entryId: entry.id });
          }
        }
      }

      // Group by entryId for display
      const byEntry = new Map();
      for (const r of fileResults) {
        if (!byEntry.has(r.entryId)) byEntry.set(r.entryId, []);
        byEntry.get(r.entryId).push(r);
      }
      for (const [entryId, entryResults] of byEntry) {
        const { lines, isFail, stats } = formatFileResults(entryResults, entryId);
        counters.pass += stats.pass;
        counters.fixed += stats.fixed;
        counters.fail += stats.fail;
        counters.error += stats.error;
        if (lines.length > 0) {
          if (isFail) {
            console.error(lines.join("\n"));
          } else if (verbose) {
            console.log(lines.join("\n"));
          }
        }
        if (isFail) {
          fail = true;
          for (const { res, checkName } of entryResults) {
            if (res.status === "fail" || res.status === "error") {
              failedPairs.push({ file: entryId, checkName });
            }
          }
        }
      }
    }
  }

  // Summary
  const parts = [`${totalChecks} check(s)`];
  if (counters.pass > 0) parts.push(`${counters.pass} passed`);
  if (counters.fixed > 0) parts.push(`${counters.fixed} fixed`);
  if (counters.fail > 0) parts.push(`${counters.fail} failed`);
  if (counters.error > 0) parts.push(`${counters.error} errored`);
  console.log(`Summary: ${parts.join(", ")}`);

  if (!fail) {
    console.log(`${lintOnly ? "Linting" : "Fixing"} completed.`);
  }

  return { extraFiles, failed: fail, failedPairs };
};

/**
 * Install the linter as a git pre-commit hook.
 *
 * Writes a small shell script into .git/hooks/pre-commit that invokes
 * dist/linter.mjs with --fix --mode hook. If a hook already exists
 * it is backed up to pre-commit.bak before overwriting.
 */
const installHook = () => {
  const gitDirResult = spawnSync("git", ["rev-parse", "--git-dir"], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
  });
  if (gitDirResult.error || gitDirResult.status !== 0) {
    console.error("Not a git repository. Cannot install hook.");
    process.exit(1);
  }
  const hooksDir = path.resolve(REPO_ROOT, gitDirResult.stdout.trim(), "hooks");
  const hookPath = path.join(hooksDir, "pre-commit");

  // Path from repo root to the current script (works both from source and bundle)
  const relLinterPath = path.relative(REPO_ROOT, __filename);

  const hookContent = `#!/bin/sh\nnode "${relLinterPath}" --fix --mode hook\n`;

  if (fs.existsSync(hookPath)) {
    const backup = hookPath + ".bak";
    fs.copyFileSync(hookPath, backup);
    console.log(`Existing pre-commit hook backed up to ${path.basename(backup)}`);
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  console.log(`Installed pre-commit hook at ${path.relative(REPO_ROOT, hookPath)}`);
};

/**
 * Detect how the linter was installed.
 * @returns {"npm" | "yarn" | "package-manager" | "single-file"}
 */
const detectInstallMethod = () => {
  const sep = path.sep;

  // Yarn classic global install path usually contains "/yarn/global/node_modules/".
  if (__filename.includes(`${sep}yarn${sep}global${sep}node_modules${sep}`) &&
      __filename.includes(`node_modules${sep}@skyrim-multiplayer${sep}linter`)) {
    return "yarn";
  }

  // npm global install path usually contains "/lib/node_modules/".
  if (__filename.includes(`${sep}lib${sep}node_modules${sep}`) &&
      __filename.includes(`node_modules${sep}@skyrim-multiplayer${sep}linter`)) {
    return "npm";
  }

  // Package manager install detected, but specific manager is unknown.
  if (__filename.includes(`node_modules${sep}@skyrim-multiplayer${sep}linter`)) {
    return "package-manager";
  }

  return "single-file";
};

/**
 * Print version info.
 */
const printVersion = () => {
  const method = detectInstallMethod();
  console.log(`skymp-linter ${LINTER_VERSION} (${LINTER_COMMIT}) [${method}]`);
};

/**
 * Upgrade the linter based on install method.
 */
const upgrade = () => {
  const method = detectInstallMethod();
  console.log(`Current: skymp-linter ${LINTER_VERSION} (${LINTER_COMMIT}) [${method}]`);
  console.log();

  // TODO: Research best-practice global upgrade commands for npm/yarn/pnpm/bun.
  switch (method) {
    case "yarn": {
      console.log("Installed via yarn. Install the latest version:");
      console.log();
      console.log(`  yarn global add "${YARN_INSTALL_SPEC}"`);
      console.log();
      break;
    }
    case "npm": {
      console.log("Installed via npm. Remove the old global version first, then install the latest:");
      console.log();
      console.log("  npm uninstall -g @skyrim-multiplayer/linter");
      console.log(`  npm install -g "${YARN_INSTALL_SPEC}"`);
      console.log();
      break;
    }
    case "package-manager": {
      console.log("Installed via a package manager, but it could not be identified automatically.");
      console.log("Run one set to upgrade:");
      console.log();
      console.log(`  yarn global add "${YARN_INSTALL_SPEC} "`);
      console.log();
      console.log("  npm uninstall -g @skyrim-multiplayer/linter");
      console.log(`  npm install -g "${YARN_INSTALL_SPEC}"`);
      console.log();
      break;
    }
    case "single-file": {
      const tmpPath = __filename + ".tmp";
      console.log(`Downloading latest linter from ${UPGRADE_URL}...`);
      try {
        execSync(
          `curl -fSL --retry 3 --retry-delay 5 -o "${tmpPath}" "${UPGRADE_URL}"`,
          { stdio: "inherit" }
        );
      } catch {
        try { fs.unlinkSync(tmpPath); } catch {}
        console.error("Download failed.");
        process.exit(1);
      }

      // Sanity check: the downloaded file should start with a shebang
      const head = fs.readFileSync(tmpPath, "utf-8").slice(0, 100);
      if (!head.startsWith("#!/")) {
        fs.unlinkSync(tmpPath);
        console.error("Downloaded file does not look like a valid linter bundle. Aborting.");
        process.exit(1);
      }

      fs.renameSync(tmpPath, __filename);
      fs.chmodSync(__filename, 0o755);
      console.log(`Updated ${__filename}`);

      // Print new version
      try {
        execSync(`node "${__filename}" --version`, { stdio: "inherit" });
      } catch {}
      break;
    }
  }
};

/**
 * Print dynamic help text built from the registry.
 */
const printHelp = () => {
  const lines = [];
  lines.push("skymp-linter — configurable linter runner with built-in checks");
  lines.push("");
  lines.push("USAGE:");
  lines.push("  skymp-linter <command> [options]");
  lines.push("");
  lines.push("COMMANDS:");
  lines.push("  --lint                Run checks in read-only mode (exit 1 on failure)");
  lines.push("  --fix                 Run checks in fix mode (modify files in-place)");
  lines.push("  --install-hook        Install as a git pre-commit hook and exit");
  lines.push("  --init                Generate a minimal linter-config.json in the repo root");
  lines.push("");
  lines.push("  --help                Show this help message");
  lines.push("  --version             Show version and install method");
  lines.push("  --upgrade             Upgrade to the latest version");
  lines.push("");
  lines.push("OPTIONS:");

  lines.push("  --verbose             Print [PASS] lines (hidden by default)");
  lines.push("  --mode <name>         Execution mode from config (default: manual)");
  lines.push("  --checks <n1,n2,...>  Only run checks with these names (comma-separated, from config)");
  lines.push("  --files <p1,p2,...>   Use these exact files instead of the configured file source");
  lines.push("  --no-download         Do not download tools if missing");
  lines.push("  --no-path             Do not search for tools in PATH");
  lines.push("  --output-prd [path]   Write a ralph-compatible PRD JSON to [path] after linting (requires --lint); defaults to prd.json");
  lines.push("");

  // --- Built-in checks ---
  lines.push("BUILT-IN CHECKS:");
  for (const [exportName, Cls] of Object.entries(builtinChecks)) {
    if (typeof Cls.getHelp === "function") {
      const h = Cls.getHelp();
      lines.push(`  ${exportName}`);
      lines.push(`    ${h.description}`);
      if (h.options) lines.push(`    Options: ${h.options}`);
    } else {
      lines.push(`  ${exportName}`);
    }
  }
  lines.push("");

  // --- Built-in file sources ---
  lines.push("BUILT-IN FILE SOURCES:");
  for (const [exportName, Cls] of Object.entries(builtinFileSources)) {
    if (typeof Cls.getHelp === "function") {
      const h = Cls.getHelp();
      lines.push(`  ${exportName}`);
      lines.push(`    ${h.description}`);
      if (h.options) lines.push(`    Options: ${h.options}`);
    } else {
      lines.push(`  ${exportName}`);
    }
  }
  lines.push("");

  // --- Built-in expanders ---
  lines.push("BUILT-IN EXPANDERS:");
  for (const [exportName, Cls] of Object.entries(builtinExpanders)) {
    if (typeof Cls.getHelp === "function") {
      const h = Cls.getHelp();
      lines.push(`  ${exportName}`);
      lines.push(`    ${h.description}`);
      if (h.options) lines.push(`    Options: ${h.options}`);
    } else {
      lines.push(`  ${exportName}`);
    }
  }
  lines.push("");

  lines.push("CONFIGURATION:");
  lines.push("  Place linter-config.json in the repo root. Run --init to generate one.");


  console.log(lines.join("\n"));
};

/**
 * Generate a minimal linter-config.json in the repo root.
 */
const initConfig = () => {
  const configPath = path.join(REPO_ROOT, "linter-config.json");
  if (fs.existsSync(configPath)) {
    console.error(`linter-config.json already exists at ${configPath}`);
    process.exit(1);
  }

  const checkEntries = Object.keys(builtinChecks).map((exportName) => ({
    name: exportName.replace(/Check$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
    export: exportName,
    modes: ["manual", "hook", "ci"],
    options: {},
  }));

  const config = {
    toolsDir: "tools",
    modes: {
      manual: { fileSource: { export: "AllFilesSource" } },
      hook: { fileSource: { export: "StagedFilesSource" } },
      ci: { fileSource: { export: "DiffBaseSource", options: {} } },
    },
    checks: checkEntries,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Created ${path.relative(REPO_ROOT, configPath)}`);
};

/**
 * Build a ralph-compatible PRD JSON from failed (file, check) pairs.
 *
 * @param {Array<{ file: string, checkName: string }>} failedPairs
 * @param {object} prdConfig  Top-level `prd` object from linter-config.json (may be empty).
 * @param {object[]} checkEntries  Raw check entries from linter-config.json (for per-check prd config).
 * @returns {object}  PRD object ready to JSON.stringify.
 */
const buildPrd = (failedPairs, prdConfig, checkEntries, baseCommand) => {
  const project = prdConfig.project || "Project";
  const branchName = prdConfig.branchName || "ralph/lint-fixes";
  const description = prdConfig.description || "Fix outstanding lint issues";

  // Build a lookup: checkName -> prd config from check entry
  const checkPrdMap = {};
  for (const entry of checkEntries || []) {
    if (entry.prd) {
      checkPrdMap[entry.name] = entry.prd;
    }
  }

  const userStories = [];
  let counter = 1;

  // Group by check name, sort files within each check alphabetically
  const byCheck = new Map();
  for (const { file, checkName } of failedPairs) {
    if (!byCheck.has(checkName)) byCheck.set(checkName, []);
    byCheck.get(checkName).push(file);
  }
  for (const files of byCheck.values()) files.sort((a, b) => a.localeCompare(b));

  // Sort checks alphabetically for stable output
  const sortedChecks = [...byCheck.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Build a lookup of ALL check names per group from the full config (not just failing ones)
  const groupToAllCheckNames = new Map();
  for (const entry of checkEntries || []) {
    if (entry.prd?.group) {
      if (!groupToAllCheckNames.has(entry.prd.group)) groupToAllCheckNames.set(entry.prd.group, []);
      groupToAllCheckNames.get(entry.prd.group).push(entry.name);
    }
  }

  // Separate checks into prd-grouped vs ungrouped
  const prdGroups = new Map(); // groupName -> [{ checkName, files, checkPrd }]
  const ungroupedChecks = [];
  for (const [checkName, files] of sortedChecks) {
    const checkPrd = checkPrdMap[checkName] || {};
    if (checkPrd.group) {
      if (!prdGroups.has(checkPrd.group)) prdGroups.set(checkPrd.group, []);
      prdGroups.get(checkPrd.group).push({ checkName, files, checkPrd });
    } else {
      ungroupedChecks.push({ checkName, files, checkPrd });
    }
  }

  const pushStory = (title, storyDescription, acceptanceCriteria) => {
    const idStr = `US-${String(counter).padStart(3, "0")}`;
    userStories.push({
      id: idStr,
      title,
      description: storyDescription,
      acceptanceCriteria,
      priority: counter,
      passes: false,
      notes: "",
    });
    counter++;
  };

  // Emit stories per prd group, respecting filesPerStory
  for (const [groupName, members] of [...prdGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Use groupTitle / groupDescription from the first member that defines them
    const groupTitleTemplate = members.map(m => m.checkPrd.groupTitle).find(Boolean);
    const groupDescTemplate = members.map(m => m.checkPrd.groupDescription).find(Boolean);
    const filesPerStory = members.map(m => m.checkPrd.filesPerStory).find(v => v != null) ?? 1;

    // Description: groupDescription wins; fall back to merging userStoryDescription from all members
    const resolveDesc = (v) => Array.isArray(v) ? v.join("\n") : v;
    const memberDescs = members.map(m => resolveDesc(m.checkPrd.userStoryDescription)).filter(Boolean);
    const rawDescTemplate = groupDescTemplate
      ? resolveDesc(groupDescTemplate)
      : memberDescs.length
        ? memberDescs.map((d, i) => `${i + 1}) ${d}`).join("\n\n")
        : null;

    const allChecks = members.map(m => m.checkName).join(", ");
    // Collect any additionalAcceptanceCriteria from all members (deduplicated)
    const extraCriteria = [...new Set(members.flatMap(m => m.checkPrd.additionalAcceptanceCriteria || []))];

    // Union of all files across the group, sorted — used for chunking
    const allFiles = [...new Set(members.flatMap(m => m.files))].sort((a, b) => a.localeCompare(b));

    for (let i = 0; i < allFiles.length; i += filesPerStory) {
      const chunkSet = new Set(allFiles.slice(i, i + filesPerStory));
      const chunkRelFiles = [...chunkSet].map(relPath);
      const fileCount = chunkRelFiles.length;

      const applyGroupPlaceholders = (str) =>
        str
          .replace(/\{files?\}/g, chunkRelFiles.join(", "))
          .replace(/\{fileCount\}/g, String(fileCount))
          .replace(/\{checks?\}/g, allChecks)
          .replace(/\{group\}/g, groupName);

      const title = groupTitleTemplate
        ? applyGroupPlaceholders(groupTitleTemplate)
        : fileCount === 1
          ? `Fix ${allChecks} issues in ${chunkRelFiles[0]}`
          : `Fix ${allChecks} issues in ${fileCount} files (${groupName})`;

      const storyDescription = rawDescTemplate
        ? applyGroupPlaceholders(rawDescTemplate)
        : `As a developer, I need to fix ${allChecks} issues in ${fileCount} file${fileCount === 1 ? "" : "s"} so all checks in the "${groupName}" group pass.`;

      // One acceptance criterion for the whole group using all check names (including non-failing),
      // comma-separated. Checks with prd.prdOnly: true are excluded.
      const allGroupCheckNames = (groupToAllCheckNames.get(groupName) || members.map(m => m.checkName))
        .filter((name) => {
          const entry = (checkEntries || []).find((e) => e.name === name);
          return !entry?.prd?.prdOnly;
        });
      const mainCriteria = allGroupCheckNames.length > 0
        ? [`${baseCommand} --lint --checks ${allGroupCheckNames.join(",")} --files ${chunkRelFiles.join(",")}`]
        : [];

      pushStory(title, storyDescription, [...mainCriteria, ...extraCriteria]);
    }
  }

  // Emit stories for ungrouped checks (original per-check, per-chunk logic).
  // prdOnly checks must belong to a group to be meaningful; skip them if ungrouped.
  for (const { checkName, files, checkPrd } of ungroupedChecks) {
    if (checkPrd.prdOnly) continue;
    const filesPerStory = checkPrd.filesPerStory ?? 1;

    for (let i = 0; i < files.length; i += filesPerStory) {
      const chunk = files.slice(i, i + filesPerStory);
      const relFiles = chunk.map(relPath);
      const filesStr = relFiles.join(",");
      const fileCount = chunk.length;

      const applyPlaceholders = (str) =>
        str
          .replace(/\{files?\}/g, relFiles.join(", "))
          .replace(/\{fileCount\}/g, String(fileCount))
          .replace(/\{check\}/g, checkName);

      const defaultTitle = fileCount === 1
        ? `Fix ${checkName} in ${relFiles[0]}`
        : `Fix ${checkName} in ${fileCount} files`;
      const title = checkPrd.userStoryTitle
        ? applyPlaceholders(checkPrd.userStoryTitle)
        : defaultTitle;

      const rawDescription = Array.isArray(checkPrd.userStoryDescription)
        ? checkPrd.userStoryDescription.join("\n")
        : checkPrd.userStoryDescription;
      const defaultDescription = fileCount === 1
        ? `As a developer, I need to fix ${checkName} issue in ${relFiles[0]} so the check passes.`
        : `As a developer, I need to fix ${checkName} issues in ${fileCount} files so the checks pass.`;
      const storyDescription = rawDescription
        ? applyPlaceholders(rawDescription)
        : defaultDescription;

      const mainCriteria = `${baseCommand} --lint --checks ${checkName} --files ${filesStr}`;
      const additionalCriteria = checkPrd.additionalAcceptanceCriteria || [];
      pushStory(title, storyDescription, [mainCriteria, ...additionalCriteria]);
    }
  }

  return { project, branchName, description, userStories };
};


/**
 * CLI Entry Point
 *
 * Flags:
 *   --verbose        Show [PASS] lines (hidden by default)
 *   --lint           Run checks in read-only mode (exit 1 on failure)
 *   --fix            Run checks in fix mode (modify files in-place)
 *   --no-download    Do not download tools if missing
 *   --no-path        Do not search for tools in PATH
 *   --mode <mode>    Execution mode (key in config.modes, default: manual)
 *   --install-hook   Install as a git pre-commit hook and exit
 *   --help           Show help message
 *   --version        Show version and install method
 *   --upgrade        Upgrade to the latest version
 *   --init           Generate minimal linter-config.json
 *   --checks <names>      Comma-separated list of check names to run (filters by config name)
 *   --files <paths>       Comma-separated file paths to lint/fix (bypasses configured file source)
 *   --output-prd <path>  Write a ralph-compatible PRD JSON to <path> (requires --lint)
 */
(async () => {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    printVersion();
    process.exit(0);
  }

  if (args.includes("--upgrade")) {
    upgrade();
    process.exit(0);
  }

  if (args.includes("--install-hook")) {
    installHook();
    process.exit(0);
  }

  if (args.includes("--init")) {
    initConfig();
    process.exit(0);
  }

  const shouldLint = args.includes("--lint");
  const shouldFix = args.includes("--fix");
  const verbose = args.includes("--verbose");
  const shouldDownload = !args.includes("--no-download");
  const shouldSearchInPath = !args.includes("--no-path");

  const outputPrdIndex = args.indexOf("--output-prd");
  let outputPrdPath = null;
  if (outputPrdIndex !== -1) {
    const next = args[outputPrdIndex + 1];
    outputPrdPath = (next && !next.startsWith("--")) ? next : "prd.json";
  }

  if (outputPrdPath !== null && !shouldLint) {
    console.error("--output-prd requires --lint to be specified.");
    process.exit(1);
  }

  const modeIndex = args.indexOf("--mode");
  const mode = modeIndex !== -1 && args[modeIndex + 1] ? args[modeIndex + 1] : "manual";

  const checksIndex = args.indexOf("--checks");
  const checksFilter = checksIndex !== -1 && args[checksIndex + 1]
    ? args[checksIndex + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const filesIndex = args.indexOf("--files");
  const filesArg = filesIndex !== -1 && args[filesIndex + 1]
    ? args[filesIndex + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  if (!shouldLint && !shouldFix) {
    console.error("Either --lint or --fix must be specified. Run --help for usage.");
    process.exit(127);
  }
  try {
    let { fileSource, checks, toolsDir, prdConfig, checkEntries } = await loadConfig(mode);

    // Apply --checks filter
    if (checksFilter !== null) {
      const found = new Set();
      checks = checks.filter((c) => {
        if (checksFilter.includes(c.name)) {
          found.add(c.name);
          return true;
        }
        return false;
      });
      for (const requested of checksFilter) {
        if (!found.has(requested)) {
          console.warn(`Warning: --checks: no check named "${requested}" found in config.`);
        }
      }
    }

    if (checks.length === 0) {
      console.log(`No checks enabled for mode "${mode}".`);
      process.exit(0);
    }

    console.log(`Mode: ${mode} | Source: ${fileSource.name} | Checks: ${checks.map((c) => c.name).join(", ")}`);

    const toolOptions = { shouldDownload, shouldSearchInPath, toolsDir };
    const deps = {};
    for (const check of checks) {
      Object.assign(deps, await check.resolveDeps(toolOptions));
    }

    // Apply --files override or use file source
    let files;
    if (filesArg !== null) {
      files = filesArg.map((f) => path.isAbsolute(f) ? f : path.resolve(REPO_ROOT, f));
    } else {
      files = await fileSource.resolve();
    }
    console.log(`${fileSource.name}: ${files.length} file(s)`);

    const startTime = Date.now();
    const runResult = await runChecks(files, checks, { lintOnly: shouldLint, verbose, ...deps });
    const elapsedMs = Date.now() - startTime;
    const minutes = Math.floor(elapsedMs / 60000);
    const seconds = ((elapsedMs % 60000) / 1000).toFixed(2);
    const timeStr =
      minutes > 0
        ? `${minutes} minutes, ${seconds} seconds`
        : `${seconds} seconds`;
    console.log(`Completed in ${timeStr}`);

    // Write PRD if requested (before any exit calls)
    if (outputPrdPath !== null) {
      const relScript = path.relative(REPO_ROOT, process.argv[1]);
      const baseCommand = relScript.startsWith("..") ? `node ${process.argv[1]}` : `node ${relScript}`;
      const prd = buildPrd(runResult.failedPairs || [], prdConfig, checkEntries, baseCommand);
      const absOutputPrdPath = path.isAbsolute(outputPrdPath) ? outputPrdPath : path.resolve(process.cwd(), outputPrdPath);
      fs.writeFileSync(absOutputPrdPath, JSON.stringify(prd, null, 2) + "\n");
      console.log(`PRD written to ${absOutputPrdPath}`);
    }

    if (files.length === 0) {
      console.log("No files were processed.");
      process.exit(0);
    }

    if (runResult.failed) {
      process.exit(1);
    }

    if (!shouldFix) {
      process.exit(0);
    }

    if (mode === "hook") {
      const allFiles = [...files, ...(runResult.extraFiles || [])];
      allFiles.forEach((file) =>
        ensureCleanExit(spawnSync("git", ["add", file], { stdio: "inherit" }))
      );
    }
  } catch (err) {
    console.error("Error during processing:", err.message);
    process.exit(1);
  }
})();
