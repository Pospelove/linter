/**
 * Registry of built-in checks and file sources.
 *
 * linter-config.json references checks and file sources
 * by their export name (e.g. "CrlfCheck") and we resolve them here.
 */

// --- checks ---
import { CrlfCheck } from "./checks/crlf-check.js";
import { EncodingCheck } from "./checks/encoding-check.js";
import { LinelintCheck } from "./checks/linelint-check.js";
import { ClangFormatCheck } from "./checks/clang-format-check.js";
import { PairedFilesCheck } from "./checks/paired-files-check.js";
import { CodegenCheck } from "./checks/codegen-check.js";
import { AiPromptCheck } from "./checks/ai-prompt-check.js";
import { RegexCheck } from "./checks/regex-check.js";
import { FirecrawlCheck } from "./checks/firecrawl-check.js";
import { CompositeCheck } from "./checks/composite-check.js";
import { TscCheck } from "./checks/tsc-check.js";
import { AlwaysFailCheck } from "./checks/always-fail-check.js";
import { LocalizationKeyCheck } from "./checks/localization-key-check.js";
import { CustomCheck } from "./checks/custom-check.js";
import { TestFindingCheck } from "./checks/test-finding-check.js";

// --- file sources ---
import { AllFilesSource } from "./file-sources/all-files-source.js";
import { StagedFilesSource } from "./file-sources/staged-files-source.js";
import { DiffBaseSource } from "./file-sources/diff-base-source.js";

export const builtinChecks = {
  CrlfCheck,
  EncodingCheck,
  LinelintCheck,
  ClangFormatCheck,
  PairedFilesCheck,
  CodegenCheck,
  AiPromptCheck,
  RegexCheck,
  FirecrawlCheck,
  CompositeCheck,
  TscCheck,
  AlwaysFailCheck,
  LocalizationKeyCheck,
  CustomCheck,
  TestFindingCheck,
};

export const builtinFileSources = {
  AllFilesSource,
  StagedFilesSource,
  DiffBaseSource,
};

export const builtinRegistry = {
  ...builtinChecks,
  ...builtinFileSources,
};
