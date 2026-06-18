import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * Composes two checks: one for linting and another for fixing.
 *
 * This enables hybrid strategies like "detect with regex, fix with AI"
 * without modifying existing check classes.
 *
 * Created automatically by the runner when a config entry has a "fixWith" block.
 */
export class CompositeCheck extends BaseCheck {
  #linter: BaseCheck;
  #fixer: BaseCheck;

  constructor(linter: BaseCheck, fixer: BaseCheck) {
    super(linter.repoRoot);
    this.#linter = linter;
    this.#fixer = fixer;
  }

  override get name(): string {
    return this.#linter.name;
  }

  override get priority(): number {
    return this.#linter.priority;
  }

  override async appliesTo(file: string): Promise<boolean> {
    return this.#linter.appliesTo(file);
  }

  override checkDeps(deps: any): boolean {
    return this.#linter.checkDeps(deps) && this.#fixer.checkDeps(deps);
  }

  override async resolveDeps(options: any): Promise<any> {
    const a = await this.#linter.resolveDeps(options);
    const b = await this.#fixer.resolveDeps(options);
    return { ...a, ...b };
  }

  override async lint(file: string, deps: any): Promise<CheckResult> {
    return this.#linter.lint(file, deps);
  }

  override async fix(file: string, deps: any): Promise<CheckResult> {
    return this.lintAndFix(file, deps);
  }

  override async lintAndFix(file: string, deps: any): Promise<CheckResult> {
    const lintRes = await this.#linter.lint(file, deps);
    if (lintRes.status !== "fail") {
      return lintRes;
    }
    return this.#fixer.fix(file, deps);
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "CompositeCheck",
      description:
        "Composes two checks: one for linting and another for fixing. " +
        "Created automatically when a config entry includes a \"fixWith\" block.",
      options: "N/A — configured via fixWith in linter-config.json",
    };
  }
}
