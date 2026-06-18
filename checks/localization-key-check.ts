import fs from "fs/promises";
import path from "path";
import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * Verifies that every _L("key") call in usage files has a corresponding
 * _LRegisterTranslationImpl registration in the configured registration files.
 *
 * Options:
 *   registrationFiles        — (required) array of paths (relative to repo root)
 *                              containing _LRegisterTranslationImpl("lang", "key", ...) calls.
 *   lFunctionName            — usage function name to scan for (default: "_L")
 *   registerFunctionName     — registration function name (default: "_LRegisterTranslationImpl")
 *   language                 — if set, only accept registrations for this language tag,
 *                              e.g. "en" (default: null = any language)
 *   excludeRegistrationFiles — skip registration files themselves when checking usage
 *                              (default: true)
 *
 * Example config entry:
 *   {
 *     "name": "l10n-keys",
 *     "export": "LocalizationKeyCheck",
 *     "modes": ["manual", "hook", "ci"],
 *     "options": {
 *       "registrationFiles": ["Scripts/Source/SweetPie.psc"],
 *       "language": "en",
 *       "extensions": [".psc"]
 *     }
 *   }
 */
export class LocalizationKeyCheck extends BaseCheck {
  #registrationFiles: string[];
  #lFunctionName: string;
  #registerFunctionName: string;
  #registryPattern: string | null;
  #language: string | null;
  #excludeRegistrationFiles: boolean;

  #registeredKeys: Set<string> | null = null;
  #registryErrors: string[] = [];

  constructor(repoRoot: string, options: any = {}) {
    super(repoRoot, options);

    if (!options.registrationFiles || options.registrationFiles.length === 0) {
      throw new Error("LocalizationKeyCheck requires a non-empty 'registrationFiles' option");
    }

    this.#registrationFiles = options.registrationFiles.map((f: string) =>
      path.resolve(repoRoot, f)
    );
    this.#lFunctionName = options.lFunctionName ?? "_L";
    this.#registerFunctionName = options.registerFunctionName ?? "_LRegisterTranslationImpl";
    this.#registryPattern = options.registryPattern ?? null;
    this.#language = options.language ?? null;
    this.#excludeRegistrationFiles = options.excludeRegistrationFiles ?? true;
  }

  override get name(): string {
    return "Localization Key Check";
  }

  override async appliesTo(file: string): Promise<boolean> {
    if (!(await super.appliesTo(file))) return false;
    if (this.#excludeRegistrationFiles) {
      const abs = path.resolve(file);
      if (this.#registrationFiles.some((r) => r === abs)) return false;
    }
    return true;
  }

  async #loadRegistry(): Promise<void> {
    if (this.#registeredKeys !== null) return;

    this.#registeredKeys = new Set<string>();
    this.#registryErrors = [];

    let re: RegExp;
    if (this.#registryPattern !== null) {
      re = new RegExp(this.#registryPattern, "g");
    } else {
      const fn = escapeRegex(this.#registerFunctionName);
      re = new RegExp(
        `${fn}\\s*\\(\\s*(?:"([^"]*)"\\s*,\\s*"([^"]*)"|'([^']*)'\\s*,\\s*'([^']*)')`,
        "g"
      );
    }

    for (const filePath of this.#registrationFiles) {
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch (err: any) {
        this.#registryErrors.push(
          `cannot read registration file ${path.relative(this.repoRoot, filePath)}: ${err.message}`
        );
        continue;
      }

      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        if (this.#registryPattern !== null) {
          const key = m[1];
          if (key !== undefined) this.#registeredKeys.add(key);
        } else {
          const lang = m[1] ?? m[3];
          const key = m[2] ?? m[4];
          if (this.#language === null || lang === this.#language) {
            if (key) this.#registeredKeys.add(key);
          }
        }
      }
    }
  }

  override async lint(file: string, _deps: any): Promise<CheckResult> {
    try {
      await this.#loadRegistry();

      if (this.#registryErrors.length > 0) {
        return { status: "error", output: this.#registryErrors.join("\n") };
      }

      const content = await fs.readFile(file, "utf-8");
      const violations = findUnregisteredKeys(content, this.#lFunctionName, this.#registeredKeys!);

      if (violations.length > 0) {
        return {
          status: "fail",
          output: `Unregistered ${this.#lFunctionName}() keys (${violations.length}):\n${violations.join("\n")}`,
        };
      }
      return { status: "pass" };
    } catch (err: any) {
      return { status: "error", output: err.message };
    }
  }

  override async fix(file: string, deps: any): Promise<CheckResult> {
    return this.lint(file, deps);
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "LocalizationKeyCheck",
      description:
        'Ensures every _L("key") call has a matching _LRegisterTranslationImpl entry, preventing missing or misspelled localization keys.',
      options:
        "registrationFiles (required), lFunctionName, registerFunctionName, registryPattern, language, excludeRegistrationFiles",
    };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} content
 * @param {string} fnName
 * @param {Set<string>} registeredKeys
 * @returns {string[]}
 */
function findUnregisteredKeys(content: string, fnName: string, registeredKeys: Set<string>): string[] {
  const fn = escapeRegex(fnName);
  const re = new RegExp(`\\b${fn}\\s*\\(\\s*(?:"([^"]*)"|'([^']*)')`, "g");

  const violations: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const key = m[1] ?? m[2];
      if (key && !registeredKeys.has(key)) {
        violations.push(`  line ${i + 1}: ${fnName}("${key}")`);
      }
    }
  }

  return violations;
}
