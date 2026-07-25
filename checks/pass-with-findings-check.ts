import { BaseCheck, CheckResult } from "./base-check.js";

/**
 * Test-only check: returns status "pass" with a non-empty findings array.
 * This deliberately violates the runner invariant
 * (findings.length == 0 iff status == "pass") documented in
 * docs/per-finding-workflow.md → "Universal invariant", so integration
 * tests can lock down the runner's implementation-bug throw.
 * Not intended for real linting.
 */
export class PassWithFindingsCheck extends BaseCheck {
  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    this.name = "pass-with-findings";
  }

  override async lint(_file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    return {
      status: "pass",
      findings: [
        { message: "invariant violation: pass with a finding", snippet: "sentinel" },
      ],
    };
  }

  override async fix(file: string, deps: Record<string, unknown>): Promise<CheckResult> {
    return this.lint(file, deps);
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "PassWithFindingsCheck",
      description:
        "Test-only check that returns status \"pass\" with a finding to exercise the runner's invariant enforcement. Do not use in real configs.",
      options: "extensions, includePaths, excludePaths, textOnly, priority (inherited from BaseCheck)",
    };
  }
}
