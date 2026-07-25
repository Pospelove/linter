import { BaseCheck } from "./base-check.js";
/**
 * A check used for testing the finding invariant:
 * "If a check returns status: pass with findings.length > 0, the runner rejects it (implementation bug)."
 */
export class TestFindingCheck extends BaseCheck {
    constructor(repoRoot, options = {}) {
        super(repoRoot, options);
        this.name = "test-finding";
    }
    async lint(_file, _deps) {
        return {
            status: "pass",
            findings: [{ message: "this should not happen", snippet: "" }],
        };
    }
    static getHelp() {
        return {
            name: "TestFindingCheck",
            description: "Returns status: pass with findings to test runner invariant.",
            options: "extensions, includePaths, excludePaths, textOnly, priority (inherited from BaseCheck)",
        };
    }
}
