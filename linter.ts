import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync, execSync } from "child_process";
import pLimit from "p-limit";

import { ensureCleanExit } from "./util.js";
import { builtinRegistry, builtinChecks, builtinFileSources } from "./registry.js";
import { CompositeCheck } from "./checks/composite-check.js";
import { BaseCheck, CheckResult, CheckFinding } from "./checks/base-check.js";

const __filename = fileURLToPath(import.meta.url);

interface LinterCheckResult extends CheckResult {
  content?: string;
  extraFiles?: string[];
}

interface ResultGroup {
  res: LinterCheckResult;
  checkName: string;
  file: string;
}

interface CheckPrdConfig {
  group?: string;
  groupTitle?: string;
  groupDescription?: string;
  filesPerStory?: number;
  userStoryTitle?: string;
  userStoryDescription?: string | string[];
  additionalAcceptanceCriteria?: string[];
  prdOnly?: boolean;
  storySplitMode?: "per-file" | "per-finding";
  findingsPerStory?: number;
  omitWorkflow?: boolean;
}

interface CheckConfigEntry {
  name: string;
  export: string;
  modes: string[];
  options?: Record<string, unknown>;
  fixWith?: { export: string; options?: Record<string, unknown> };
  prd?: CheckPrdConfig;
  expander?: { export: string; options?: Record<string, unknown> };
}

interface PrdConfig {
  project?: string;
  branchName?: string;
  description?: string;
  storySplitMode?: "per-file" | "per-finding";
  findingsPerStory?: number;
  group?: string;
  filesPerStory?: number;
  omitWorkflow?: boolean;
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
  // git always reports forward slashes, even on Windows, while Node builds
  // paths with path.sep. Without normalizing, every REPO_ROOT comparison
  // (relPath, path.relative) silently fails and absolute paths leak out.
  return path.resolve(result.stdout.trim());
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
    if (entry.expander) {
      console.error(`${entry.name}: 'expander' is no longer supported. See docs/per-finding-workflow.md.`);
      process.exit(2);
    }
    checks.push(check);
  }


  const prdConfig = config.prd || {};
  
  const storySplitMode = prdConfig.storySplitMode || "per-file";
  if (storySplitMode !== "per-file" && storySplitMode !== "per-finding") {
    console.error(`Invalid prd.storySplitMode: ${storySplitMode}. Valid values are: per-file, per-finding`);
    process.exit(2);
  }
  
  const findingsPerStory = prdConfig.findingsPerStory !== undefined ? prdConfig.findingsPerStory : 1;
  
  if (storySplitMode === "per-finding") {
    if (prdConfig.group) {
      console.error("per-finding + prd.group is not allowed");
      process.exit(2);
    }
    if (prdConfig.filesPerStory !== undefined && prdConfig.filesPerStory !== 1) {
      console.error("per-finding + filesPerStory != 1 is not allowed");
      process.exit(2);
    }
    if (typeof findingsPerStory !== "number" || !Number.isInteger(findingsPerStory) || findingsPerStory <= 0) {
      console.error("per-finding + findingsPerStory <= 0 or non-integer is not allowed");
      process.exit(2);
    }
  } else if (prdConfig.findingsPerStory !== undefined) {
    console.warn("findingsPerStory is ignored when storySplitMode is not per-finding");
  }
  
  prdConfig.storySplitMode = storySplitMode;
  prdConfig.findingsPerStory = findingsPerStory;

  for (const entry of config.checks || []) {
    const cp = entry.prd;
    if (!cp || cp.storySplitMode === undefined) continue;
    if (cp.storySplitMode !== "per-file" && cp.storySplitMode !== "per-finding") {
      console.error(`Invalid prd.storySplitMode on check "${entry.name}": ${cp.storySplitMode}. Valid values are: per-file, per-finding`);
      process.exit(2);
    }
    if (cp.storySplitMode === "per-finding") {
      if (cp.group) {
        console.error(`per-finding + prd.group is not allowed on check "${entry.name}"`);
        process.exit(2);
      }
      if (cp.filesPerStory !== undefined && cp.filesPerStory !== 1) {
        console.error(`per-finding + filesPerStory != 1 is not allowed on check "${entry.name}"`);
        process.exit(2);
      }
      const n = cp.findingsPerStory !== undefined ? cp.findingsPerStory : 1;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        console.error(`per-finding + findingsPerStory <= 0 or non-integer is not allowed on check "${entry.name}"`);
        process.exit(2);
      }
    } else if (cp.findingsPerStory !== undefined) {
      console.warn(`findingsPerStory is ignored on check "${entry.name}" when storySplitMode is not per-finding`);
    }
  }

  return { fileSource, checks, toolsDir, prdConfig, checkEntries: config.checks };

};

/**
 * Quote a command-line argument if it contains anything a shell would split
 * on. Check names like "Raw Float Angles (C++)" are legal in the config but
 * produce an unrunnable acceptance criterion when pasted in bare.
 */
const shellQuote = (arg: string) => {
  if (arg !== "" && !/[^A-Za-z0-9_\-.,/=:+@]/.test(arg)) {
    return arg;
  }
  return `"${arg.split("\\").join("\\\\").split('"').join('\\"')}"`;
};

/**
 * Make path relative to REPO_ROOT for compact output.
 */
const relPath = (file: string) => {
  if (file.startsWith(REPO_ROOT + path.sep)) {
    // Repo-relative paths are reported with forward slashes on every
    // platform, matching git, so output and PRDs stay identical between
    // Windows and CI.
    return file.slice(REPO_ROOT.length + 1).split(path.sep).join("/");
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

const enforceInvariant = async (res: LinterCheckResult, file: string): Promise<LinterCheckResult> => {
  if (res.status === "pass" && res.findings && res.findings.length > 0) {
    return { ...res, status: "error", output: "Invariant violation: status is pass but findings are present." };
  }
  if ((res.status === "fail" || res.status === "error") && (!res.findings || res.findings.length === 0)) {
    res.findings = [{ message: res.output ?? "check failed", snippet: "" }];
  }
  if (res.findings && res.findings.length > 0) {
    let fileLines: string[] | null = null;
    for (const finding of res.findings) {
      if (!finding.snippet && finding.startLine !== undefined && finding.endLine !== undefined) {
        if (!fileLines) {
          try {
            fileLines = fs.readFileSync(file, "utf-8").split("\n");
          } catch {
            fileLines = [];
          }
        }
        finding.snippet = fileLines.slice(finding.startLine - 1, finding.endLine).join("\n");
      }
    }
  }
  return res;
};

const formatFileResults = (results: { res: LinterCheckResult; checkName: string }[], file: string) => {
  const rel = relPath(file);
  const lines: string[] = [];
  let isFail = false;
  const stats = { pass: 0, fixed: 0, fail: 0, error: 0 };

  const passed: string[] = [];
  const fixed: string[] = [];
  const bad: { res: LinterCheckResult; checkName: string }[] = [];

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
 * failedPairs: Array<{ file: string, checkName: string }>
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

  if (lintOnly) {
    // Parallel lint: controlled by p-limit per file
    const limit = pLimit(10); // reasonable default for lints
    await Promise.all(
      groupedWork.map(({ file, checks }) =>
        limit(async () => {
          const results = await Promise.all(
            checks.map(async (check) => {
              try {
                let res = await check.lint(file, deps);
                res = await enforceInvariant(res, file);
                return { res, checkName: check.name, file };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                let errorRes: LinterCheckResult = { status: "error", output: message };
                errorRes = await enforceInvariant(errorRes, file);
                return { res: errorRes, checkName: check.name, file };
              }
            })
          );

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
            for (const { res, checkName } of results) {
              if (res.status === "fail" || res.status === "error") {
                if (res.findings) {
                for (const finding of res.findings) {
                  failedPairs.push({ file, checkName, finding });
                }
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
      const fileResults: ResultGroup[] = [];

      for (const check of checks) {
        try {
          let res = (await check.lintAndFix(file, deps)) || await check.fix(file, deps);
          res = await enforceInvariant(res, file);
          if (res.extraFiles) res.extraFiles.forEach((f) => extraFiles.add(f));
          fileResults.push({ res, checkName: check.name, file });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          let errorRes: LinterCheckResult = { status: "error", output: message };
          errorRes = await enforceInvariant(errorRes, file);
          fileResults.push({ res: errorRes, checkName: check.name, file });
        }
      }

      const { lines, isFail, stats } = formatFileResults(fileResults, file);
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
        for (const { res, checkName } of fileResults) {
          if (res.status === "fail" || res.status === "error") {
            const finding = res.findings?.[0] ?? { message: res.output ?? "check failed", snippet: "" };
            failedPairs.push({ file, checkName, finding });
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
  lines.push("  --no-download         Do not download tools if missing");
  lines.push("  --no-path             Do not search for tools in PATH");
  lines.push("  --output-prd [path]   Write a ralph-compatible PRD JSON to [path] after linting (requires --lint); defaults to prd.json");
  lines.push("  --expect-max <N>      Exit 0 if the (single) --checks/--files pair has <= N findings, exit 1 otherwise (requires --lint)");
  lines.push("  --show <mode>         first | all — print JSON of earliest / all findings for the single --checks/--files pair (requires --lint)");
  lines.push("  --json                Emit one structured JSON blob to stdout with all per-file findings (requires --lint)");
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
 * @param {Array<{ file: string, checkName: string }>} failedPairs
 * @param {PrdConfig} prdConfig  Top-level `prd` object from linter-config.json (may be empty).
 * @param {CheckConfigEntry[]} checkEntries  Raw check entries from linter-config.json (for per-check prd config).
 * @returns {object}  PRD object ready to JSON.stringify.
 */
const buildPrd = (failedPairs: { file: string, checkName: string, finding?: import("./checks/base-check.js").CheckFinding }[], prdConfig: PrdConfig, checkEntries: CheckConfigEntry[], baseCommand: string) => {
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

  const pushStoryShared = (title: string, storyDescription: string | null, acceptanceCriteria: string[]) => {
    const idStr = "US-" + String(counter).padStart(3, "0");
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

  const effectiveMode = (checkName: string): "per-file" | "per-finding" => {
    const cp = checkPrdMap[checkName];
    if (cp && cp.storySplitMode) return cp.storySplitMode;
    return prdConfig.storySplitMode === "per-finding" ? "per-finding" : "per-file";
  };
  const effectiveFindingsPerStory = (checkName: string): number => {
    const cp = checkPrdMap[checkName];
    if (cp && cp.findingsPerStory !== undefined) return cp.findingsPerStory;
    return prdConfig.findingsPerStory || 1;
  };

  const perFindingPairs = failedPairs.filter((p) => effectiveMode(p.checkName) === "per-finding");
  const perFilePairs = failedPairs.filter((p) => effectiveMode(p.checkName) === "per-file");

  if (perFindingPairs.length > 0) {
    const pushStory = pushStoryShared;
    const checkOrder = (checkEntries || []).map((e) => e.name);
    // Nested map: file -> check -> findings[]. Avoids string-key collisions when
    // file paths or check names contain any delimiter.
    const perFileGroups = new Map<string, Map<string, import("./checks/base-check.js").CheckFinding[]>>();
    for (const pair of perFindingPairs) {
      let byCheck = perFileGroups.get(pair.file);
      if (!byCheck) {
        byCheck = new Map();
        perFileGroups.set(pair.file, byCheck);
      }
      let arr = byCheck.get(pair.checkName);
      if (!arr) {
        arr = [];
        byCheck.set(pair.checkName, arr);
      }
      if (pair.finding) arr.push(pair.finding);
    }

    const sortedFiles = Array.from(perFileGroups.keys()).sort((a, b) => a.localeCompare(b));
    const checkOrderIdx = (name: string) => {
      const i = checkOrder.indexOf(name);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };

    for (const file of sortedFiles) {
      const byCheck = perFileGroups.get(file)!;
      const sortedChecks = Array.from(byCheck.keys()).sort((a, b) => checkOrderIdx(a) - checkOrderIdx(b));
      for (const check of sortedChecks) {
      const findings = byCheck.get(check)!;
      const M = findings.length;
      const N = effectiveFindingsPerStory(check);
      const S = Math.ceil(M / N);
      const checkPrd = checkPrdMap[check] || {};
      const relFile = relPath(file);
      
      for (let K = 1; K <= S; K++) {
        const Nk = Math.min(N, M - (K - 1) * N);
        const expectMax = Math.max(0, M - K * N);
        const startLine = findings[0]?.startLine;
        const endLine = findings[0]?.endLine;
        const snippet = findings[0]?.snippet || "";
        const message = findings[0]?.message || "";
        
        let title = "";
        if (M === 1) {
          title = startLine !== undefined ? "Fix " + check + " in " + relFile + ":" + startLine : "Fix " + check + " in " + relFile;
        } else if (S === 1 && M > 1) {
          title = "Fix " + check + " in " + relFile + " (" + M + " findings)";
        } else {
          title = "Fix " + check + " in " + relFile + " (story " + K + " of " + S + "; " + Nk + " findings)";
        }
        
        const workflowTemplate = "File:  {file}\nCheck: {check}\nFindings at PRD generation: {findingCount}. Fixed by prior stories: " + ((K - 1) * N) + ".\nThis story fixes exactly {storyBudget} finding(s). STOP after {storyBudget} iterations, even\nif more remain — later stories cover them. Any remaining finding may be\naddressed; findings are interchangeable.\n\nRepeat exactly {storyBudget} times:\n  1. Locate the earliest remaining finding:\n       " + baseCommand + " --lint --checks {checkArg} --files {fileArg} --show first\n  2. Read only the affected range:\n       Read({file}, offset: startLine - 2, limit: (endLine - startLine) + 5)\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\n\nTool names above (Read, Edit) are Claude Code's; if you're a different\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\nwhat matter: read a small range around the finding, then replace the\nreturned snippet exactly.\n\nThen verify:\n  " + baseCommand + " --lint --checks {checkArg} --files {fileArg} --expect-max {expectMax}";

        const applyPlaceholders = (str: string) => {
          return str
            .replace(/\{fileArg\}/g, shellQuote(relFile))
            .replace(/\{file\}/g, relFile)
            .replace(/\{files\}/g, relFile)
            .replace(/\{fileCount\}/g, "1")
            .replace(/\{checkArg\}/g, shellQuote(check))
            .replace(/\{check\}/g, check)
            .replace(/\{findingCount\}/g, String(M))
            .replace(/\{storyCount\}/g, String(S))
            .replace(/\{storyIndex\}/g, String(K))
            .replace(/\{storyBudget\}/g, String(Nk))
            .replace(/\{expectMax\}/g, String(expectMax))
            .replace(/\{startLine\}/g, startLine !== undefined ? String(startLine) : "")
            .replace(/\{endLine\}/g, endLine !== undefined ? String(endLine) : "")
            .replace(/\{message\}/g, message)
            .replace(/\{snippet\}/g, snippet)
            .replace(/\{findings\}/g, JSON.stringify(findings))
            .replace(/\{workflow\}/g, workflowTemplate
                .replace(/\{fileArg\}/g, shellQuote(relFile))
                .replace(/\{file\}/g, relFile)
                .replace(/\{checkArg\}/g, shellQuote(check))
                .replace(/\{check\}/g, check)
                .replace(/\{findingCount\}/g, String(M))
                .replace(/\{storyBudget\}/g, String(Nk))
                .replace(/\{startLine\}/g, startLine !== undefined ? String(startLine) : "")
                .replace(/\{endLine\}/g, endLine !== undefined ? String(endLine) : "")
                .replace(/\{expectMax\}/g, String(expectMax)));
        };

        const rawDescription = Array.isArray(checkPrd.userStoryDescription)
          ? checkPrd.userStoryDescription.join("\n")
          : checkPrd.userStoryDescription;

        const omitWorkflow = checkPrd.omitWorkflow ?? prdConfig.omitWorkflow ?? false;
        const parts: string[] = [];
        if (rawDescription) parts.push(applyPlaceholders(rawDescription));
        if (!omitWorkflow) parts.push(applyPlaceholders(workflowTemplate));
        const storyDescription = parts.join("\n\n");

        const mainCriteria = baseCommand + " --lint --checks " + shellQuote(check) + " --files " + shellQuote(relFile) + " --expect-max " + expectMax;
        const additionalCriteria = checkPrd.additionalAcceptanceCriteria || [];
        pushStory(title, storyDescription, [mainCriteria, ...additionalCriteria]);
      }
      }
    }
  }

  if (perFilePairs.length > 0) {
    // Legacy per-file mode. Nested map (check -> file -> pair) keeps the dedupe
    // safe regardless of what characters appear in file paths or check names.
    const dedupedByCheck = new Map<string, Map<string, typeof perFilePairs[number]>>();
    for (const pair of perFilePairs) {
      let byFile = dedupedByCheck.get(pair.checkName);
      if (!byFile) {
        byFile = new Map();
        dedupedByCheck.set(pair.checkName, byFile);
      }
      if (!byFile.has(pair.file)) byFile.set(pair.file, pair);
    }
    const failedPairs: (typeof perFilePairs[number])[] = [];
    for (const byFile of dedupedByCheck.values()) {
      for (const pair of byFile.values()) failedPairs.push(pair);
    }

  // Group by check name, sort files within each check alphabetically
  const byCheck = new Map<string, string[]>();
  for (const { file, checkName } of failedPairs) {
    if (!byCheck.has(checkName)) byCheck.set(checkName, []);
    byCheck.get(checkName)!.push(file);
  }
  for (const files of byCheck.values()) files.sort((a: string, b: string) => a.localeCompare(b));

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
  const prdGroups = new Map<string, { checkName: string; files: string[]; checkPrd: CheckPrdConfig }[]>(); // groupName -> [{ checkName, files, checkPrd }]
  const ungroupedChecks: { checkName: string; files: string[]; checkPrd: CheckPrdConfig }[] = [];
  for (const [checkName, files] of sortedChecks) {
    const checkPrd = checkPrdMap[checkName] || {};
    if (checkPrd.group) {
      if (!prdGroups.has(checkPrd.group)) prdGroups.set(checkPrd.group, []);
      prdGroups.get(checkPrd.group)!.push({ checkName, files, checkPrd });
    } else {
      ungroupedChecks.push({ checkName, files, checkPrd });
    }
  }

  const pushStory = (title: string, storyDescription: string | null, acceptanceCriteria: string[]) => {
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

    const allFiles = [...new Set(members.flatMap((m) => m.files))].sort((a, b) => a.localeCompare(b));

    for (let i = 0; i < allFiles.length; i += filesPerStory) {
      const chunkSet = new Set(allFiles.slice(i, i + filesPerStory));
      const chunkRelFiles = [...chunkSet].map(relPath);
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
        ? [`${baseCommand} --lint --checks ${shellQuote(allGroupCheckNames.join(","))} --files ${shellQuote(chunkRelFiles.join(","))}`]
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

      const mainCriteria = `${baseCommand} --lint --checks ${shellQuote(checkName)} --files ${shellQuote(filesStr)}`;
      const additionalCriteria = checkPrd.additionalAcceptanceCriteria || [];
      pushStory(title, storyDescription, [mainCriteria, ...additionalCriteria]);
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

  
  const expectMaxIndex = args.indexOf("--expect-max");
  let expectMax: number | null = null;
  if (expectMaxIndex !== -1) {
    const val = args[expectMaxIndex + 1];
    const n = Number(val);
    if (!Number.isInteger(n) || n < 0) {
      console.error("--expect-max requires a non-negative integer");
      process.exit(2);
    }
    expectMax = n;
  }

  const showIndex = args.indexOf("--show");
  let showMode: string | null = null;
  if (showIndex !== -1) {
    showMode = args[showIndex + 1] ?? null;
    if (showMode !== "first" && showMode !== "all") {
      console.error("--show only accepts 'first' or 'all'");
      process.exit(2);
    }
  }

  const jsonMode = args.includes("--json");

  const outputPrdIndex = args.indexOf("--output-prd");
  let outputPrdPath: string | null = null;
  if (outputPrdIndex !== -1) {
    const next = args[outputPrdIndex + 1];
    outputPrdPath = (next && !next.startsWith("--")) ? next : "prd.json";
  }

  const modeIndex = args.indexOf("--mode");
  const modeParam = modeIndex !== -1 ? args[modeIndex + 1] : null;
  const mode = modeParam ?? "manual";

  const checksIndex = args.indexOf("--checks");
  const checksArg = checksIndex !== -1 ? args[checksIndex + 1] : null;
  const checksFilter = checksArg
    ? checksArg.split(",").map((s: string) => s.trim()).filter(Boolean)
    : null;

  const filesIndex = args.indexOf("--files");
  const filesParam = filesIndex !== -1 ? args[filesIndex + 1] : null;
  const filesArg = filesParam
    ? filesParam.split(",").map((s: string) => s.trim()).filter(Boolean)
    : null;

  // Validations for --expect-max
  if (expectMax !== null) {
    if (!shouldLint || shouldFix) {
      console.error("--expect-max requires --lint and rejects --fix");
      process.exit(2);
    }
    if (outputPrdPath !== null) {
      console.error("--expect-max rejects --output-prd");
      process.exit(2);
    }
    if (showMode !== null) {
      console.error("--expect-max rejects --show");
      process.exit(2);
    }
    if (checksFilter === null || checksFilter.length !== 1 || filesArg === null || filesArg.length !== 1) {
      console.error("--expect-max requires exactly one --checks and exactly one --files");
      process.exit(2);
    }
  }

  // Validations for --show
  if (showMode !== null) {
    if (!shouldLint || shouldFix) {
      console.error("--show requires --lint and rejects --fix");
      process.exit(2);
    }
    if (outputPrdPath !== null) {
      console.error("--show rejects --output-prd");
      process.exit(2);
    }
    if (checksFilter === null || checksFilter.length !== 1 || filesArg === null || filesArg.length !== 1) {
      console.error("--show requires exactly one --checks and exactly one --files");
      process.exit(2);
    }
  }

  if (outputPrdPath !== null && !shouldLint) {
    console.error("--output-prd requires --lint to be specified.");
    process.exit(1);
  }

  // Validations for --json
  if (jsonMode) {
    if (!shouldLint || shouldFix) {
      console.error("--json requires --lint and rejects --fix");
      process.exit(2);
    }
    if (outputPrdPath !== null) {
      console.error("--json rejects --output-prd");
      process.exit(2);
    }
    if (expectMax !== null) {
      console.error("--json rejects --expect-max");
      process.exit(2);
    }
    if (showMode !== null) {
      console.error("--json rejects --show");
      process.exit(2);
    }
  }


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

    const info = jsonMode ? console.error : console.log;
    info(`Mode: ${mode} | Source: ${fileSource.name} | Checks: ${checks.map((c) => c.name).join(", ")}`);

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
    info(`${fileSource.name}: ${files.length} file(s)`);

    
    if (expectMax !== null || showMode !== null) {
      if (checks.length === 0) {
        console.error("Check not found or not enabled in this mode.");
        process.exit(2);
      }
      if (files.length === 0) {
        console.error("File not found.");
        process.exit(2);
      }
      const check = checks[0];
      const file = files[0];
      if (!await check.appliesTo(file)) {
        console.error("Check does not apply to this file.");
        process.exit(2);
      }

      let res = await check.lint(file, deps);
      res = await enforceInvariant(res, file);
      const findings = res.findings || [];

      if (expectMax !== null) {
        if (findings.length <= expectMax) {
          console.log(`Expected at most ${expectMax} finding(s), found ${findings.length}. If you're an AI agent fixing this step by step, you are OK to proceed.`);
          process.exit(0);
        } else {
          const PREVIEW_CAP = 3;
          const preview = findings.slice(0, PREVIEW_CAP);
          console.log(`${findings.length} finding(s) remaining, expected at most ${expectMax}. Showing first ${preview.length}:`);
          for (const f of preview) {
            console.log(f.message);
            if (f.startLine !== undefined) console.log(`line ${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ''}`);
            if (f.snippet) console.log(f.snippet);
          }
          const remaining = findings.length - preview.length;
          if (remaining > 0) {
            console.log(`(and ${remaining} more — use --show first for the earliest finding with fresh coordinates)`);
          }
          process.exit(1);
        }
      } else if (showMode === "first" || showMode === "all") {
        if (findings.length === 0) {
          console.log(showMode === "first" ? "null" : "[]");
          process.exit(0);
        }

        findings.sort((a: CheckFinding, b: CheckFinding) => (a.startLine ?? 0) - (b.startLine ?? 0));

        let fileLines: string[] = [];
        try {
          fileLines = fs.readFileSync(file, "utf-8").split("\n");
        } catch {
          fileLines = [];
        }

        const checkUnique = (lines: string[]) => {
          if (lines.length === 0) return true;
          const str = lines.join("\n");
          const fullStr = fileLines.join("\n");
          let count = 0;
          let idx = fullStr.indexOf(str);
          while (idx !== -1) {
            count++;
            if (count > 1) return false;
            idx = fullStr.indexOf(str, idx + 1);
          }
          return count === 1;
        };

        const widen = (finding: CheckFinding) => {
          const startL = finding.startLine ?? 1;
          const endL = finding.endLine ?? 1;
          let up = 2;
          let down = 2;
          let snippetLines = fileLines.slice(Math.max(0, startL - 1 - up), Math.min(fileLines.length, endL + down));
          let unique = checkUnique(snippetLines);
          if (!unique) {
            for (let step = 1; step <= 20; step++) {
              up++;
              down++;
              snippetLines = fileLines.slice(Math.max(0, startL - 1 - up), Math.min(fileLines.length, endL + down));
              if (checkUnique(snippetLines)) {
                unique = true;
                break;
              }
            }
          }
          const out: Record<string, unknown> = {
            startLine: finding.startLine,
            endLine: finding.endLine,
            snippet: snippetLines.join("\n"),
            message: finding.message,
          };
          if (!unique) out["unique"] = false;
          return out;
        };

        if (showMode === "first") {
          console.log(JSON.stringify(widen(findings[0]!)));
        } else {
          console.log(JSON.stringify(findings.map(widen)));
        }
        process.exit(0);
      }
    }

    if (jsonMode) {
      const jsonOut: { files: { path: string; results: { check: string; status: string; output?: string; findings: CheckFinding[] }[] }[]; summary: { pass: number; fail: number; fixed: number; error: number } } = {
        files: [],
        summary: { pass: 0, fail: 0, fixed: 0, error: 0 },
      };
      let anyFail = false;
      for (const file of files) {
        const rel = relPath(file);
        const fileEntry: { path: string; results: { check: string; status: string; output?: string; findings: CheckFinding[] }[] } = { path: rel, results: [] };
        for (const check of checks) {
          if (!check.checkDeps(deps)) continue;
          if (!(await check.appliesTo(file))) continue;
          let res: LinterCheckResult;
          try {
            res = await check.lint(file, deps);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res = { status: "error", output: msg };
          }
          res = await enforceInvariant(res, file);
          const entry: { check: string; status: string; output?: string; findings: CheckFinding[] } = {
            check: check.name,
            status: res.status,
            findings: res.findings ?? [],
          };
          if (res.output !== undefined) entry.output = res.output;
          fileEntry.results.push(entry);
          if (res.status === "fail" || res.status === "error") anyFail = true;
          jsonOut.summary[res.status]++;
        }
        if (fileEntry.results.length > 0) jsonOut.files.push(fileEntry);
      }
      console.log(JSON.stringify(jsonOut));
      process.exit(anyFail ? 1 : 0);
    }

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
      // A PRD gets committed and handed to other machines, so an absolute
      // path to whoever generated it is useless. In-repo copies stay
      // relative; a globally installed linter is referenced by its bin name.
      const insideRepo =
        scriptPath !== "" && relScript !== "" &&
        !relScript.startsWith("..") && !path.isAbsolute(relScript);
      const baseCommand = insideRepo
        ? `node ${relScript.split(path.sep).join("/")}`
        : "skymp-linter";
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
