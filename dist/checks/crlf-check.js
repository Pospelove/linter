import fs from "fs/promises";
import { BaseCheck } from "./base-check.js";
export class CrlfCheck extends BaseCheck {
    constructor(repoRoot, options = {}) {
        super(repoRoot, options);
        this.name = "CRLF";
    }
    async lint(file, _deps) {
        try {
            const content = await fs.readFile(file);
            if (content.includes("\r\n")) {
                return { status: "fail", output: "contains CRLF line endings" };
            }
            return { status: "pass" };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", output: message };
        }
    }
    async fix(file, _deps) {
        try {
            const before = await fs.readFile(file);
            if (before.includes("\r\n")) {
                const fixed = before.toString("utf-8").replace(/\r\n/g, "\n");
                await fs.writeFile(file, Buffer.from(fixed, "utf-8"));
                return { status: "fixed" };
            }
            return { status: "pass" };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { status: "error", output: message };
        }
    }
    static getHelp() {
        return {
            name: "CrlfCheck",
            description: "Detects and fixes CRLF (\\r\\n) line endings, replacing them with LF (\\n).",
            options: "extensions — file extensions to check (e.g. [\".cpp\", \".h\", \".js\"])",
        };
    }
}
