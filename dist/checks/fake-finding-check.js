import { BaseCheck } from "./base-check.js";
import { deriveFingerprint } from "./finding-fingerprint.js";
/**
 * A check that returns configurable findings from options.
 * Used for testing fingerprint determinism and PRD generation.
 */
export class FakeFindingCheck extends BaseCheck {
    #findings;
    #testPaths;
    constructor(repoRoot, options = {}) {
        super(repoRoot, options);
        this.name = String(options["name"] || "fake-finding");
        const findings = options["findings"];
        this.#findings = Array.isArray(findings) ? findings : [];
        this.#testPaths = Array.isArray(options["testPaths"]) ? options["testPaths"].map(String) : [];
    }
    async lint(_file, _deps) {
        const outputs = [];
        for (const badPath of this.#testPaths) {
            try {
                deriveFingerprint(this.name, badPath, "snippet", this.repoRoot);
                outputs.push(`FAILED to catch non-portable path: ${badPath}`);
            }
            catch (err) {
                outputs.push(`Caught expected error for ${badPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (outputs.length > 0) {
            return { status: "fail", output: outputs.join("\n") };
        }
        return {
            status: "fail",
            findings: this.#findings.map(f => ({ ...f })),
        };
    }
    static getHelp() {
        return {
            name: "FakeFindingCheck",
            description: "Returns configurable findings for testing.",
            options: "name, findings (array of CheckFinding objects)",
        };
    }
}
