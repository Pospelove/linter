import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * A check that always fails every file it applies to.
 * Intended for PRD-only use: pair with `prd.prdOnly: true` so it
 * contributes to a grouped user story without adding an acceptance
 * criterion command of its own.
 */
export class AlwaysFailCheck extends BaseCheck {
  override get name(): string {
    return "always-fail";
  }

  override async lint(_file: string, _deps: any): Promise<CheckResult> {
    return { status: "fail", output: "always-fail: this check always fails" };
  }

  override async fix(_file: string, _deps: any): Promise<CheckResult> {
    return { status: "fail", output: "always-fail: this check cannot be fixed automatically" };
  }

  static override getHelp() {
    return {
      name: "AlwaysFailCheck",
      description: "Always fails every file. Use with prd.prdOnly to contribute to PRD user stories without generating acceptance criteria.",
      options: "extensions, includePaths, excludePaths, textOnly, priority (inherited from BaseCheck)",
    };
  }
}
