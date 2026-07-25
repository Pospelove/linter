import { execFile } from "child_process";
import { promisify } from "util";
import { BaseCheck } from "./base-check.js";
import fs from "fs/promises";
import { getLinelintPath } from "../tool-resolve/linelint.js";
const execFileAsync = promisify(execFile);
export class LinelintCheck extends BaseCheck {
    constructor(repoRoot, options = {}) {
        super(repoRoot, options);
        this.name = "Linelint";
    }
    async resolveDeps(options) {
        const linelintPath = await getLinelintPath({
            shouldDownload: !!options["shouldDownload"],
            shouldSearchInPath: !!options["shouldSearchInPath"],
            toolsDir: typeof options["toolsDir"] === "string" ? options["toolsDir"] : ".linter/tools",
        });
        return { linelintPath };
    }
    checkDeps(deps) {
        return typeof deps["linelintPath"] === "string";
    }
    async lint(file, deps) {
        const linelintPath = deps["linelintPath"];
        if (typeof linelintPath !== "string") {
            return { status: "error", output: "linelint binary path not resolved" };
        }
        try {
            await execFileAsync(linelintPath, [file], { cwd: this.repoRoot });
            return { status: "pass" };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
                return { status: "error", output: message };
            }
            const stderr = (err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string") ? err.stderr : "";
            const stdout = (err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string") ? err.stdout : "";
            const out = (stderr || stdout || "").trim();
            return { status: "fail", output: out || "linelint failed" };
        }
    }
    async fix(file, deps) {
        const linelintPath = deps["linelintPath"];
        if (typeof linelintPath !== "string") {
            return { status: "error", output: "linelint binary path not resolved" };
        }
        let before;
        try {
            before = await fs.readFile(file);
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
        try {
            await execFileAsync(linelintPath, ["-a", file], { cwd: this.repoRoot });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
                return { status: "error", output: message };
            }
            const stderr = (err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string") ? err.stderr : "";
            const stdout = (err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string") ? err.stdout : "";
            const out = (stderr || stdout || "").trim();
            return { status: "error", output: out || "linelint fix failed" };
        }
        try {
            const after = await fs.readFile(file);
            if (!before.equals(after)) {
                return { status: "fixed" };
            }
            return { status: "pass" };
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
    }
    static getHelp() {
        return {
            name: "LinelintCheck",
            description: "Runs linelint to enforce final-newline and trailing-whitespace rules. Auto-downloads the binary if needed.",
            options: "(uses linelint config from repo root)",
        };
    }
}
