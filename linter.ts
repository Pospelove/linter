import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync, execSync } from "child_process";
import pLimit from "p-limit";

import { ensureCleanExit } from "./util.js";
import { builtinRegistry, builtinChecks, builtinFileSources } from "./registry.js";
import { CompositeCheck } from "./checks/composite-check.js";
import { BaseCheck, CheckResult, CheckFinding } from "./checks/base-check.js";
import { deriveFingerprint, decodeFingerprint } from "./checks/finding-fingerprint.js";

const __filename = fileURLToPath(import.meta.url);

interface LinterCheckResult extends CheckResult {
  extraFiles?: string[];
}

interface ResultGroup {
  res: LinterCheckResult;
  checkName: string;
  findings: CheckFinding[];
}

/**
 * Normalize check findings: synthesize for legacy failures, populate snippets
 * from line ranges, and enforce the "pass with findings" invariant.
 */
const normalizeFindings = async (file: string, checkName: string, res: LinterCheckResult): Promise<CheckFinding[]> => {
  if (res.status === "pass") {
    if (res.findings && res.findings.length > 0) {
      throw new Error(`Implementation bug in check "${checkName}": returned "pass" status with ${res.findings.length} findings for file "${file}".`);
    }
    return [];
  }

  const findings = res.findings ? [...res.findings] : [];
  if (findings.length === 0 && (res.status === "fail" || res.status === "error")) {
    findings.push({ message: res.output ?? "check failed", snippet: "" });
  }

  // Snippet population rule
  let content: string[] | null = null;
  for (const finding of findings) {
    if ((finding.startLine || finding.endLine) && !finding.snippet) {
      if (content === null) {
        try {
          content = (await fs.promises.readFile(file, "utf-8")).split("\n");
        } catch (err) {
          throw new Error(`Failed to read file "${file}" to populate snippet for check "${checkName}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const start = Math.max(0, (finding.startLine ?? 1) - 1);
      const end = finding.endLine ?? finding.startLine ?? (start + 1);
      finding.snippet = content.slice(start, end).join("\n");
    }

    // Fingerprint injection rule
    finding.fingerprint = deriveFingerprint(checkName, file, finding.snippet, REPO_ROOT);
  }

  return findings;
};

interface CheckPrdConfig {
  group?: string;
  groupTitle?: string;
  groupDescription?: string;
  storySplitMode?: "per-file" | "per-finding";
  findingsPerStory?: number;
  filesPerStory?: number;
  userStoryTitle?: string;
  userStoryDescription?: string | string[];
  additionalAcceptanceCriteria?: string[];
  prdOnly?: boolean;
}

interface CheckConfigEntry {
  name: string;
  export: string;
  modes: string[];
  options?: Record<string, unknown>;
  fixWith?: { export: string; options?: Record<string, unknown> };
  prd?: CheckPrdConfig;
}

interface PrdConfig {
  project?: string;
  branchName?: string;
  description?: string;
}

/* global __LINTER_VERSION__, __LINTER_COMMIT__ */
// @ts-expect-error - global
const LINTER_VERSION = typeof __LINTER_VERSION__ !== "undefined" ? __LINTER_VERSION__ : "dev";
// @ts-expect-error - global
const LINTER_COMMIT = typeof __LINTER_COMMIT__ !== "undefined" ? __LINTER_COMMIT__ : "unknown";

const UPGRADE_URL = "https://raw.githubusercontent.com/skyrim-multiplayer/linter/main/dist/linter.mjs";
const YARN_INSTALL_SPEC = "https://github.com/skyrim-multiplayer/linter#main";

const getRepoRoot = () => {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  if (result.error || result.status !== 0) {
    console.warn("Warning: not a git repository, using cwd for repo root");
    return process.cwd();
  }
  return result.stdout.trim();
};

const REPO_ROOT = getRepoRoot();

/**
 * Resolve a class from config entry by looking up "export" in the built-in registry.
 */
const resolveClass = async (entry: { export: string }) => {
  const exportName = entry.export;
  // @ts-expect-error - indexing builtinRegistry
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
const loadConfig = async (mode: string) => {
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

  // Reject any check entry that still carries an "expander" block. Expanders
  // were removed by the per-finding workflow; findings replace them.
  for (const entry of config.checks) {
    if (entry.expander !== undefined) {
      throw new Error(
        `Check "${entry.name}" has an "expander" block, but expanders have been removed. ` +
        `Findings replace them. See docs/per-finding-workflow.md.`
      );
    }
  }

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
    check.name = entry.name;
    check._prdConfig = entry.prd || null;

    if (entry.prd) {
      if (entry.prd.storySplitMode === "per-finding" && entry.prd.group) {
        throw new Error(`Check "${entry.name}" has storySplitMode: "per-finding" combined with prd.group. This is not supported. See docs/per-finding-workflow.md.`);
      }

      if (entry.prd.storySplitMode && !["per-file", "per-finding"].includes(entry.prd.storySplitMode)) {
        throw new Error(`Check "${entry.name}" has unknown storySplitMode "${entry.prd.storySplitMode}". Valid values: per-file, per-finding.`);
      }

      if (!entry.prd.storySplitMode && entry.prd.findingsPerStory !== undefined) {
        console.warn(`Warning: findingsPerStory is ignored when storySplitMode is not per-finding (check "${entry.name}").`);
      }
    }

    checks.push(check);
  }

  const prdConfig = config.prd || {};

  return { fileSource, checks, toolsDir, prdConfig, checkEntries: config.checks };
};

/**
 * Make path relative to REPO_ROOT for compact output.
 */
const relPath = (file: string) => {
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
 */
const formatFileResults = (results: ResultGroup[], file: string) => {
  const rel = relPath(file);
  const lines: string[] = [];
  let isFail = false;
  const stats = { pass: 0, fixed: 0, fail: 0, error: 0 };

  const passed: string[] = [];
  const fixed: string[] = [];
  const bad: ResultGroup[] = [];

  for (const group of results) {
    const { res, checkName } = group;
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
        bad.push(group);
        stats.fail++;
        break;
      case "error":
      default:
        bad.push(group);
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
      const parts: string[] = [];
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
 * Core: Run checks (lint or fix) on given files.
 *
 * Lint mode:  all (check, file) pairs run in parallel.
 * Fix mode:   one file at a time (sequential) to avoid races on shared files.
 *
 * Returns { extraFiles, failed, failedPairs } instead of calling process.exit(1).
 * failedPairs: Array<{ file: string, checkName: string, finding: CheckFinding }>
 */
const runChecks = async (files: string[], checks: BaseCheck[], { lintOnly = false, verbose = false, ...deps }: Record<string, unknown>) => {

  const extraFiles = new Set<string>();
  const failedPairs: { file: string, checkName: string, finding: CheckFinding }[] = [];

  // Group checks by file instead of a sequential flat array
  const fileToChecks = new Map<string, BaseCheck[]>();
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
        fileToChecks.get(file)!.push(check);
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
    return { extraFiles: new Set<string>(), failed: false, failedPairs: [] };
  }

  console.log(`${lintOnly ? "Linting" : "Fixing"} ${totalChecks} check(s) across ${groupedWork.length} file(s)...`);

  let fail = false;
  const counters = { pass: 0, fixed: 0, fail: 0, error: 0 };

  const emitResults = (file: string, results: ResultGroup[]) => {
    const { lines, isFail, stats } = formatFileResults(results, file);
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
      for (const { checkName, findings } of results) {
        for (const finding of findings) {
          failedPairs.push({ file, checkName, finding });
        }
      }
    }
  };

  if (lintOnly) {
    // Parallel lint: controlled by p-limit per file
    const limit = pLimit(10); // reasonable default for lints
    await Promise.all(
      groupedWork.map(({ file, checks }) =>
        limit(async () => {
          const results = await Promise.all(
            checks.map(async (check): Promise<ResultGroup> => {
              try {
                const res = await check.lint(file, deps);
                const findings = await normalizeFindings(file, check.name, res);
                return { res, checkName: check.name, findings };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const errorRes: LinterCheckResult = { status: "error", output: message };
                const findings = await normalizeFindings(file, check.name, errorRes);
                return { res: errorRes, checkName: check.name, findings };
              }
            })
          );
          emitResults(file, results);
        })
      )
    );
  } else {
    // Sequential fix: file by file, check by check to avoid file races
    for (const { file, checks } of groupedWork) {
      const fileResults: ResultGroup[] = [];

      for (const check of checks) {
        try {
          const res = (await check.lintAndFix(file, deps)) || await check.fix(file, deps);
          if (res.extraFiles) res.extraFiles.forEach((f) => extraFiles.add(f));
          const findings = await normalizeFindings(file, check.name, res);
          fileResults.push({ res, checkName: check.name, findings });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorRes: LinterCheckResult = { status: "error", output: message };
          const findings = await normalizeFindings(file, check.name, errorRes);
          fileResults.push({ res: errorRes, checkName: check.name, findings });
        }
      }

      emitResults(file, fileResults);
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
 * Install the linter into a git pre-commit hook.
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
  lines.push("  --install-hook        Install into a git pre-commit hook and exit");
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
  lines.push("  --finding <f1,...>    Only verify these findings (comma-separated fingerprints)");
  lines.push("  --expect-max <N>      Maximum instances of finding allowed to remain (default: 0)");
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

interface UserStory {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes: string;
}

/**
 * Build a ralph-compatible PRD JSON from failed (file, check) pairs.
 *
 * @param {Array<{ file: string, checkName: string, finding: CheckFinding }>} failedPairs
 * @param {PrdConfig} prdConfig  Top-level `prd` object from linter-config.json (may be empty).
 * @param {CheckConfigEntry[]} checkEntries  Raw check entries from linter-config.json (for per-check prd config).
 * @returns {object}  PRD object ready to JSON.stringify.
 */
const buildPrd = (failedPairs: { file: string, checkName: string, finding: CheckFinding }[], prdConfig: PrdConfig, checkEntries: CheckConfigEntry[], baseCommand: string) => {
  const project = prdConfig.project || "Project";
  const branchName = prdConfig.branchName || "ralph/lint-fixes";
  const description = prdConfig.description || "Fix outstanding lint issues";

  // Build a lookup: checkName -> prd config from check entry
  const checkPrdMap: Record<string, CheckPrdConfig> = {};
  for (const entry of checkEntries || []) {
    if (entry.prd) {
      checkPrdMap[entry.name] = entry.prd;
    }
  }

  const userStories: UserStory[] = [];
  let counter = 1;

  // Group by check name, sort files within each check alphabetically.
  // In per-file mode (the only mode for now), we dedupe multiple findings
  // for the same (file, check) back down to one story.
  const byCheck = new Map<string, { file: string; findings: CheckFinding[] }[]>();
  for (const { file, checkName, finding } of failedPairs) {
    if (!byCheck.has(checkName)) byCheck.set(checkName, []);
    const entries = byCheck.get(checkName)!;
    let entry = entries.find((e) => e.file === file);
    if (!entry) {
      entry = { file, findings: [] };
      entries.push(entry);
    }
    entry.findings.push(finding);
  }

  // Sort files within each check alphabetically
  for (const entries of byCheck.values()) {
    entries.sort((a, b) => a.file.localeCompare(b.file));
  }

  // Sort checks alphabetically for stable output
  const sortedChecks = [...byCheck.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Build a lookup of ALL check names per group from the full config (not just failing ones)
  const groupToAllCheckNames = new Map<string, string[]>();
  for (const entry of checkEntries || []) {
    if (entry.prd?.group) {
      if (!groupToAllCheckNames.has(entry.prd.group)) groupToAllCheckNames.set(entry.prd.group, []);
      groupToAllCheckNames.get(entry.prd.group)!.push(entry.name);
    }
  }

  // Separate checks into prd-grouped vs ungrouped
  const prdGroups = new Map<string, { checkName: string; entries: { file: string; findings: CheckFinding[] }[]; checkPrd: CheckPrdConfig }[]>(); // groupName -> [{ checkName, entries, checkPrd }]
  const ungroupedChecks: { checkName: string; entries: { file: string; findings: CheckFinding[] }[]; checkPrd: CheckPrdConfig }[] = [];
  for (const [checkName, entries] of sortedChecks) {
    const checkPrd = checkPrdMap[checkName] || {};
    if (checkPrd.group) {
      if (!prdGroups.has(checkPrd.group)) prdGroups.set(checkPrd.group, []);
      prdGroups.get(checkPrd.group)!.push({ checkName, entries, checkPrd });
    } else {
      ungroupedChecks.push({ checkName, entries, checkPrd });
    }
  }

  const pushStory = (title: string, storyDescription: string | null, acceptanceCriteria: string[], notes: string = "") => {
    const idStr = `US-${String(counter).padStart(3, "0")}`;
    userStories.push({
      id: idStr,
      title,
      description: storyDescription,
      acceptanceCriteria,
      priority: counter,
      passes: false,
      notes,
    });
    counter++;
  };

  // Emit stories per prd group, respecting filesPerStory
  for (const [groupName, members] of [...prdGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Use groupTitle / groupDescription from the first member that defines them
    const groupTitleTemplate = members.map((m) => m.checkPrd.groupTitle).find(Boolean);
    const groupDescTemplate = members.map((m) => m.checkPrd.groupDescription).find(Boolean);
    const filesPerStory = members.map((m) => m.checkPrd.filesPerStory).find((v) => v != null) ?? 1;

    // Description: groupDescription wins; fall back to merging userStoryDescription from all members
    const resolveDesc = (v: string | string[] | undefined) => Array.isArray(v) ? v.join("\n") : v;
    const memberDescs = members.map((m) => resolveDesc(m.checkPrd.userStoryDescription)).filter(Boolean);
    const rawDescTemplate = groupDescTemplate
      ? resolveDesc(groupDescTemplate)
      : memberDescs.length
        ? memberDescs.map((d, i) => `${i + 1}) ${d}`).join("\n\n")
        : null;

    const allChecks = members.map((m) => m.checkName).join(", ");
    // Collect any additionalAcceptanceCriteria from all members (deduplicated)
    const extraCriteria = [...new Set(members.flatMap((m) => m.checkPrd.additionalAcceptanceCriteria || []))];

    const allFiles = [...new Set(members.flatMap((m) => m.entries.map((e) => e.file)))].sort((a, b) => a.localeCompare(b));

    for (let i = 0; i < allFiles.length; i += filesPerStory) {
      const chunkFiles = allFiles.slice(i, i + filesPerStory);
      const chunkRelFiles = chunkFiles.map(relPath);
      const fileCount = chunkRelFiles.length;

      const applyGroupPlaceholders = (str: string) =>
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
      const allGroupCheckNames = (groupToAllCheckNames.get(groupName) || members.map((m) => m.checkName))
        .filter((name) => {
          const entry = (checkEntries || []).find((e) => e.name === name);
          return !entry?.prd?.prdOnly;
        });
      const mainCriteria = allGroupCheckNames.length > 0
        ? [`${baseCommand} --lint --checks ${allGroupCheckNames.join(",")} --files ${chunkRelFiles.join(",")}`]
        : [];

      const fingerprints = members.flatMap((m) =>
        m.entries
          .filter((e) => chunkFiles.includes(e.file))
          .flatMap((e) => e.findings.map((f) => f.fingerprint))
      );
      const notes = fingerprints.length > 0 ? `Fingerprints: ${[...new Set(fingerprints)].join(", ")}` : "";

      pushStory(title, storyDescription, [...mainCriteria, ...extraCriteria], notes);
    }
  }

  // Emit stories for ungrouped checks (original per-check, per-chunk logic).
  // prdOnly checks must belong to a group to be meaningful; skip them if ungrouped.
  for (const { checkName, entries, checkPrd } of ungroupedChecks) {
    if (checkPrd.prdOnly) continue;

    if (checkPrd.storySplitMode === "per-finding") {
      const findingsPerStory = checkPrd.findingsPerStory ?? 1;
      const filesPerStory = checkPrd.filesPerStory ?? 1;

      const applyPlaceholdersFinding = (str: string, findings: CheckFinding[], relFiles: string[], instanceIndex?: number, instanceCount?: number, expectMax?: number) => {
        const first = findings[instanceIndex != null ? instanceIndex - 1 : 0];
        const res = str
          .replace(/\{files?\}/g, relFiles.join(", "))
          .replace(/\{fileCount\}/g, String(relFiles.length))
          .replace(/\{check\}/g, checkName)
          .replace(/\{findingCount\}/g, String(findings.length))
          .replace(/\{instanceIndex\}/g, instanceIndex != null ? String(instanceIndex) : "")
          .replace(/\{instanceCount\}/g, instanceCount != null ? String(instanceCount) : "")
          .replace(/\{expectMax\}/g, expectMax != null ? String(expectMax) : "")
          .replace(/\{startLine\}/g, String(first.startLine || 1))
          .replace(/\{endLine\}/g, String(first.endLine || first.startLine || 1))
          .replace(/\{message\}/g, first.message)
          .replace(/\{snippet\}/g, first.snippet || "")
          .replace(/\{fingerprint\}/g, first.fingerprint || "");

        if (res.includes("{findings}")) {
          const rendered = findings.map((f) => `line ${f.startLine || "whole file"}: ${f.snippet || ""}`).join("\n");
          return res.replace(/\{findings\}/g, rendered);
        }
        return res;
      };

      const renderDefaultDescriptionFinding = (findings: CheckFinding[]) => {
        return findings.map((f) => {
          const range = f.startLine ? (f.endLine && f.endLine !== f.startLine ? `lines ${f.startLine}-${f.endLine}` : `line ${f.startLine}`) : "whole file";
          return `${f.message}\nRange: ${range}\nSnippet:\n${f.snippet || ""}`;
        }).join("\n\n");
      };

      const renderMultiInstanceDescription = (findings: CheckFinding[], k: number, m: number) => {
        const lines = findings.map((f) => f.startLine || "whole file");
        const first = findings[k - 1];
        const range = first.startLine ? (first.endLine && first.endLine !== first.startLine ? `lines ${first.startLine}-${first.endLine}` : `line ${first.startLine}`) : "whole file";
        return `Fix ONE remaining instance matching the snippet. At PRD generation time, ${m} instances existed at lines [${lines.join(", ")}]; ${k - 1} have already been fixed by prior stories.\n\n${first.message}\nRange: ${range}\nSnippet:\n${first.snippet || ""}`;
      };

      // Group findings by fingerprint across all files to identify multi-instance
      const globalFpFindings = new Map<string, { file: string; finding: CheckFinding }[]>();
      for (const entry of entries) {
        for (const finding of entry.findings) {
          const fp = finding.fingerprint!;
          if (!globalFpFindings.has(fp)) globalFpFindings.set(fp, []);
          globalFpFindings.get(fp)!.push({ file: entry.file, finding });
        }
      }

      // Track which fingerprints we've already emitted as multi-instance
      const emittedMultiInstance = new Set<string>();
      let uniqueQueue: { file: string; finding: CheckFinding }[] = [];

      const flushUniqueQueue = () => {
        while (uniqueQueue.length > 0) {
          const storyFindings: CheckFinding[] = [];
          const storyFiles = new Set<string>();
          const storyFpList: string[] = [];

          let j = 0;
          while (j < uniqueQueue.length) {
            const item = uniqueQueue[j];
            if (storyFindings.length >= findingsPerStory) break;
            if (!storyFiles.has(item.file) && storyFiles.size >= filesPerStory) break;

            storyFindings.push(item.finding);
            storyFiles.add(item.file);
            storyFpList.push(item.finding.fingerprint!);
            uniqueQueue.splice(j, 1);
          }

          if (storyFindings.length === 0) break;

          const relFiles = [...storyFiles].map(relPath).sort();
          const fileCount = relFiles.length;
          const findingCount = storyFindings.length;
          const first = storyFindings[0];

          const title = checkPrd.userStoryTitle
            ? applyPlaceholdersFinding(checkPrd.userStoryTitle, storyFindings, relFiles)
            : fileCount === 1
              ? findingCount === 1
                ? `Fix ${checkName} in ${relFiles[0]}:${first.startLine || 1}`
                : `Fix ${checkName} in ${relFiles[0]} (${findingCount} findings)`
              : `Fix ${checkName} in ${fileCount} files (${findingCount} findings)`;

          const storyDescription = checkPrd.userStoryDescription
            ? applyPlaceholdersFinding(Array.isArray(checkPrd.userStoryDescription) ? checkPrd.userStoryDescription.join("\n") : checkPrd.userStoryDescription, storyFindings, relFiles)
            : renderDefaultDescriptionFinding(storyFindings);

          const mainCriteria = `${baseCommand} --lint --finding ${storyFpList.join(",")}`;
          const additionalCriteria = checkPrd.additionalAcceptanceCriteria || [];

          pushStory(title, storyDescription, [mainCriteria, ...additionalCriteria], `Fingerprints: ${storyFpList.join(", ")}`);
        }
      };

      for (const entry of entries) {
        // Find all fingerprints that appear in this file
        const fpsInFile = [...new Set(entry.findings.map((f) => f.fingerprint!))];

        for (const fp of fpsInFile) {
          const allInstances = globalFpFindings.get(fp)!;
          if (allInstances.length > 1) {
            // Multi-instance: emit all stories if this is the first file it appears in
            if (!emittedMultiInstance.has(fp) && allInstances[0].file === entry.file) {
              emittedMultiInstance.add(fp);
              const m = allInstances.length;
              const instances = allInstances.map(i => i.finding);
              for (let k = 1; k <= m; k++) {
                const item = allInstances[k - 1];
                const relFile = relPath(item.file);
                const expectMax = m - k;

                const title = checkPrd.userStoryTitle
                  ? applyPlaceholdersFinding(checkPrd.userStoryTitle, instances, [relFile], k, m, expectMax)
                  : `Fix ${checkName} in ${relFile} (instance ${k} of ${m})`;

                const storyDescription = checkPrd.userStoryDescription
                  ? applyPlaceholdersFinding(Array.isArray(checkPrd.userStoryDescription) ? checkPrd.userStoryDescription.join("\n") : checkPrd.userStoryDescription, instances, [relFile], k, m, expectMax)
                  : renderMultiInstanceDescription(instances, k, m);

                const mainCriteria = `${baseCommand} --lint --finding ${fp} --expect-max ${expectMax}`;
                pushStory(title, storyDescription, [mainCriteria, ...(checkPrd.additionalAcceptanceCriteria || [])], `Fingerprint: ${fp}`);
              }
            }
          } else {
            // Unique fingerprint
            uniqueQueue.push({ file: entry.file, finding: allInstances[0].finding });
          }
        }

        // If filesPerStory is 1, we must flush after each file
        if (filesPerStory === 1) {
          flushUniqueQueue();
        }
      }
      flushUniqueQueue();
    } else {
      const filesPerStory = checkPrd.filesPerStory ?? 1;

      for (let i = 0; i < entries.length; i += filesPerStory) {
        const chunk = entries.slice(i, i + filesPerStory);
        const relFiles = chunk.map((e) => relPath(e.file));
        const filesStr = relFiles.join(",");
        const fileCount = chunk.length;

        const applyPlaceholders = (str: string) =>
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

        const fingerprints = chunk.flatMap((e) => e.findings.map((f) => f.fingerprint!));
        const notes = fingerprints.length > 0 ? `Fingerprints: ${[...new Set(fingerprints)].join(", ")}` : "";

        pushStory(title, storyDescription, [mainCriteria, ...additionalCriteria], notes);
      }
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
 *   --install-hook   Install into a git pre-commit hook and exit
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
  const modeParam = modeIndex !== -1 ? args[modeIndex + 1] : null;
  const mode = modeParam ?? "manual";

  const checksIndex = args.indexOf("--checks");
  const checksArg = checksIndex !== -1 ? args[checksIndex + 1] : null;
  const checksFilter = checksArg
    ? checksArg.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const filesIndex = args.indexOf("--files");
  const filesParam = filesIndex !== -1 ? args[filesIndex + 1] : null;
  const filesArg = filesParam
    ? filesParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const findingIndex = args.indexOf("--finding");
  const rawFindingArg = findingIndex !== -1 ? args[findingIndex + 1] : null;
  const findingArg = (rawFindingArg && !rawFindingArg.startsWith("--")) ? rawFindingArg : null;

  const expectMaxIndex = args.indexOf("--expect-max");
  const rawExpectMaxArg = expectMaxIndex !== -1 ? args[expectMaxIndex + 1] : null;
  const expectMaxArg = (rawExpectMaxArg && !rawExpectMaxArg.startsWith("--")) ? rawExpectMaxArg : "0";
  const expectMax = parseInt(expectMaxArg, 10);

  if (findingArg !== null) {
    if (filesArg !== null || checksFilter !== null || outputPrdPath !== null) {
      console.error("--finding is mutually exclusive with --files, --checks, and --output-prd.");
      process.exit(2);
    }
    if (shouldFix) {
      console.error("--fix --finding is not implemented. Per-finding auto-fix is not yet supported. Use --lint --finding to verify a specific finding, or --fix (without --finding) to apply the check's whole-file fix path.");
      process.exit(2);
    }
  }

  if (!shouldLint && !shouldFix) {
    console.error("Either --lint or --fix must be specified. Run --help for usage.");
    process.exit(127);
  }
  try {
    let { fileSource, checks, toolsDir, prdConfig, checkEntries } = await loadConfig(mode);

    if (findingArg !== null) {
      const fingerprints = findingArg.split(",");
      if (fingerprints.length > 1 && expectMaxIndex !== -1) {
        console.error("--expect-max is only valid when --finding names a single fingerprint.");
        process.exit(2);
      }

      let aggregateFail = false;
      const toolOptions = { shouldDownload, shouldSearchInPath, toolsDir };

      for (const fp of fingerprints) {
        let payload;
        try {
          payload = decodeFingerprint(fp);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }

        const checkEntry = checkEntries.find((e: CheckConfigEntry) => e.name === payload.check);
        if (!checkEntry || !checkEntry.modes.includes(mode)) {
          console.error(`Config drift: check "${payload.check}" is not in config or not enabled for mode "${mode}".`);
          process.exit(2);
        }

        const absoluteFile = path.resolve(REPO_ROOT, payload.file);
        if (!fs.existsSync(absoluteFile)) {
          console.error(`Env drift: file "${payload.file}" no longer exists in repo.`);
          process.exit(2);
        }

        const CheckClass = await resolveClass(checkEntry);
        const check = new CheckClass(REPO_ROOT, checkEntry.options || {});
        check.name = checkEntry.name;

        const deps = await check.resolveDeps(toolOptions);
        const res = await check.lint(absoluteFile, deps);
        const findings = await normalizeFindings(absoluteFile, check.name, res);

        const matchingFindings = findings.filter((f) => f.fingerprint === fp);
        const allowed = fingerprints.length === 1 ? expectMax : 0;

        if (matchingFindings.length > allowed) {
          aggregateFail = true;
          for (const f of matchingFindings) {
            const range = f.startLine
              ? f.endLine && f.endLine !== f.startLine
                ? `${f.startLine}-${f.endLine}`
                : `${f.startLine}`
              : "whole file";
            console.error(`${payload.file}:${range}: ${f.message}`);
            if (f.snippet) {
              console.error(`  Snippet: ${f.snippet.replace(/\n/g, "\n  ")}`);
            }
          }
        }
      }

      process.exit(aggregateFail ? 1 : 0);
    }

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
      const scriptPath = process.argv[1] ?? "";
      const relScript = path.relative(REPO_ROOT, scriptPath);
      const baseCommand = relScript.startsWith("..") ? `node ${scriptPath}` : `node ${relScript}`;
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
        ensureCleanExit(spawnSync("git", ["add", file], { stdio: "inherit", encoding: "utf-8" }))
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error during processing:", message);
    process.exit(1);
  }
})();
