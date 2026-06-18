import { BaseCheck } from "./base-check.js";

/**
 * Composes two checks: one for linting and another for fixing.
 *
 * This enables hybrid strategies like "detect with regex, fix with AI"
 * without modifying existing check classes.
 *
 * Created automatically by the runner when a config entry has a "fixWith" block.
 */
export class CompositeCheck extends BaseCheck {
  #linter;
  #fixer;

  constructor(linter, fixer) {
    super(linter.repoRoot);
    this.#linter = linter;
    this.#fixer = fixer;
  }

  get name() {
    return this.#linter.name;
  }

  get priority() {
    return this.#linter.priority;
  }

  async appliesTo(file) {
    return this.#linter.appliesTo(file);
  }

  checkDeps(deps) {
    return this.#linter.checkDeps(deps) && this.#fixer.checkDeps(deps);
  }

  async resolveDeps(options) {
    const a = await this.#linter.resolveDeps(options);
    const b = await this.#fixer.resolveDeps(options);
    return { ...a, ...b };
  }

  async lint(file, deps) {
    return this.#linter.lint(file, deps);
  }

  async fix(file, deps) {
    return this.lintAndFix(file, deps);
  }

  async lintAndFix(file, deps) {
    const lintRes = await this.#linter.lint(file, deps);
    if (lintRes.status !== "fail") {
      return lintRes;
    }
    return this.#fixer.fix(file, deps);
  }

  static getHelp() {
    return {
      name: "CompositeCheck",
      description:
        "Composes two checks: one for linting and another for fixing. " +
        "Created automatically when a config entry includes a \"fixWith\" block.",
      options: "N/A — configured via fixWith in linter-config.json",
    };
  }
}
