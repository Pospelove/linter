import fs from "fs/promises";
import path from "path";
import { BaseCheck } from "./base-check.js";
import { ClaudeProvider } from "../ai-providers/claude.js";
import { GeminiProvider } from "../ai-providers/gemini.js";
import { OpenAICompatibleProvider } from "../ai-providers/openai-compatible.js";
import { coerce, coerceArray, standardTemplates, resolvePaths, dedupePaths, buildFileContext, lockfilePath, lockMatchesContent, lockWriteContent, } from "./check-utils.js";
const AI_PROVIDERS = {
    claude: ClaudeProvider,
    gemini: GeminiProvider,
    openai: OpenAICompatibleProvider
};
/**
 * AI Prompt check — invokes an AI provider with a user-defined prompt.
 *
 * Operates on the whole file: reads the file, sends it to the model, and
 * optionally writes back a modified version. Non-deterministic; per the
 * per-finding workflow spec, checks like this SHOULD NOT emit per-finding
 * results — they collapse to one whole-file finding per failed file.
 *
 * Options (from linter-config.json):
 *   aiProvider     — which AI provider to use: "claude" (default) or "gemini"
 *   lintPrompt     — lint-specific instruction
 *   fixPrompt      — fix-specific instruction
 *   filesToRead    — additional files to include for context (array of paths)
 *                    Supports templates: {name_without_ext}, {name_with_ext},
 *                    {ext}, {dir}.
 *   lock           — if true, cache AI verdicts per file in .ai-prompt-lock.json
 *                    keyed by relative path and content hash.
 *   lockValue      — set to 1 to write universal lock entries instead of hashes.
 */
export class AiPromptCheck extends BaseCheck {
    #lintPrompt;
    #fixPrompt;
    #filesToRead;
    #lock;
    #lockValue;
    #provider;
    constructor(repoRoot, options = {}) {
        super(repoRoot, options);
        this.#lintPrompt = coerce(options["lintPrompt"]);
        this.#fixPrompt = coerce(options["fixPrompt"]);
        if (!this.#lintPrompt && !this.#fixPrompt) {
            throw new Error("AiPromptCheck requires at least one of: lintPrompt, fixPrompt");
        }
        this.#filesToRead = coerceArray(options["filesToRead"] ?? options["contextFiles"])
            .filter((f) => typeof f === "string");
        this.#lock = !!options["lock"];
        this.#lockValue = options["lockValue"];
        const providerName = String(options["aiProvider"] || "claude").toLowerCase();
        const ProviderClass = AI_PROVIDERS[providerName];
        if (!ProviderClass) {
            throw new Error(`Unknown aiProvider "${providerName}". Available: ${Object.keys(AI_PROVIDERS).join(", ")}`);
        }
        this.#provider = new ProviderClass();
        const label = this.#lintPrompt || this.#fixPrompt || "unnamed";
        this.name = `AI Prompt (${label.slice(0, 50)}${label.length > 50 ? "…" : ""})`;
    }
    checkDeps() {
        return true;
    }
    getTemplates() {
        return standardTemplates();
    }
    async lint(file, _deps) {
        const instruction = this.#lintPrompt;
        if (!instruction) {
            return { status: "error", output: "No prompt configured for lint (set lintPrompt)" };
        }
        let content;
        try {
            content = await fs.readFile(file, "utf-8");
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
        const lockKey = this.#lockKey(file);
        if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
            return { status: "pass" };
        }
        const ctx = await this.#buildExtraContext(file);
        if (ctx.error)
            return { status: "error", output: ctx.error };
        const prompt = this.#buildLintPrompt(file, instruction, content, ctx.value || "");
        const verdict = await this.#callAndParse(prompt);
        if (verdict.error)
            return { status: "error", output: verdict.error };
        const lockPath = lockfilePath(this.repoRoot);
        if (verdict.value && verdict.value["pass"]) {
            if (this.#lock) {
                await this.#writeLock(lockKey, content);
            }
            return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
        }
        return { status: "fail", output: String(verdict.value?.["reason"] || "AI check failed (no reason provided)") };
    }
    async fix(file, _deps) {
        const instruction = this.#fixPrompt;
        if (!instruction) {
            return { status: "error", output: "No prompt configured for fix (set fixPrompt)" };
        }
        let content;
        try {
            content = await fs.readFile(file, "utf-8");
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
        const lockKey = this.#lockKey(file);
        if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
            return { status: "pass" };
        }
        const ctx = await this.#buildExtraContext(file);
        if (ctx.error)
            return { status: "error", output: ctx.error };
        const prompt = this.#buildFixPrompt(file, instruction, content, ctx.value || "");
        const parsed = await this.#callAndParse(prompt);
        if (parsed.error)
            return { status: "error", output: parsed.error };
        const result = parsed.value;
        const lockPath = lockfilePath(this.repoRoot);
        if (!result || !result["changed"] || typeof result["content"] !== "string") {
            if (this.#lock) {
                await this.#writeLock(lockKey, content);
            }
            return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
        }
        const newContent = String(result["content"]);
        if (newContent === content) {
            return { status: "pass", output: String(result["reason"] || "AI reported changes but content was identical") };
        }
        try {
            await fs.writeFile(file, newContent, "utf-8");
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
        if (this.#lock) {
            await this.#writeLock(lockKey, newContent);
        }
        return {
            status: "fixed",
            output: String(result["reason"] || "AI applied fixes"),
            ...(this.#lock && { extraFiles: [lockPath] }),
        };
    }
    async lintAndFix(file, _deps) {
        if (!this.#lintPrompt || !this.#fixPrompt)
            return null;
        let content;
        try {
            content = await fs.readFile(file, "utf-8");
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
        const lockKey = this.#lockKey(file);
        if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
            return { status: "pass" };
        }
        const ctx = await this.#buildExtraContext(file);
        if (ctx.error)
            return { status: "error", output: ctx.error };
        const prompt = this.#buildLintAndFixPrompt(file, content, ctx.value || "");
        const parsed = await this.#callAndParse(prompt);
        if (parsed.error)
            return { status: "error", output: parsed.error };
        const result = parsed.value;
        const lockPath = lockfilePath(this.repoRoot);
        if (result && result["pass"]) {
            if (this.#lock) {
                await this.#writeLock(lockKey, content);
            }
            return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
        }
        if (!result || typeof result["content"] !== "string") {
            return { status: "fail", output: String(result?.["reason"] || "AI check failed and could not produce a fix") };
        }
        const newContent = String(result["content"]);
        if (newContent === content) {
            return { status: "pass", output: String(result["reason"] || "AI reported changes but content was identical") };
        }
        try {
            await fs.writeFile(file, newContent, "utf-8");
        }
        catch (err) {
            return { status: "error", output: err instanceof Error ? err.message : String(err) };
        }
        if (this.#lock) {
            await this.#writeLock(lockKey, newContent);
        }
        return {
            status: "fixed",
            output: String(result["reason"] || "AI applied fixes"),
            ...(this.#lock && { extraFiles: [lockPath] }),
        };
    }
    // ── prompt builders ──────────────────────────────────────────────────
    #buildLintPrompt(file, instruction, content, extraContext) {
        return (`You are a code review assistant integrated into a linter.\n` +
            `Item: ${this.#fileLabel(file)}\n` +
            `Instruction: ${instruction}\n\n` +
            `Content to review:\n${content}` +
            (extraContext ? `\n\n${extraContext}` : "") +
            `\n\nRespond with ONLY a JSON object (no markdown fences): ` +
            `{ "pass": true/false, "reason": "short explanation" }`);
    }
    #buildFixPrompt(file, instruction, content, extraContext) {
        return (`You are a code fixing assistant integrated into a linter.\n` +
            `Item to fix: ${this.#fileLabel(file)}\n` +
            `Instruction: ${instruction}\n\n` +
            `Content to fix:\n${content}` +
            (extraContext ? `\n\n${extraContext}` : "") +
            `\n\nRespond with ONLY a JSON object (no markdown fences): ` +
            `{ "changed": true/false, "reason": "short explanation", "content": "full new content in string format" }. ` +
            `The "content" field, when present, must be the entire replacement content in string format ` +
            `(use the same format like the input — if it is JSON text, return JSON text). ` +
            `If no changes are needed, set changed to false and omit content.`);
    }
    #buildLintAndFixPrompt(file, content, extraContext) {
        return (`You are a code review and fixing assistant integrated into a linter.\n` +
            `Item: ${this.#fileLabel(file)}\n\n` +
            `Lint criteria: ${this.#lintPrompt}\n` +
            `Fix instruction: ${this.#fixPrompt}\n\n` +
            `Content:\n${content}` +
            (extraContext ? `\n\n${extraContext}` : "") +
            `\n\nFirst evaluate the content against the lint criteria.\n` +
            `If it PASSES, respond with ONLY a JSON object (no markdown fences):\n` +
            `{ "pass": true, "reason": "short explanation" }\n\n` +
            `If it FAILS, apply the fix instruction and respond with ONLY a JSON object (no markdown fences):\n` +
            `{ "pass": false, "reason": "short explanation of what was wrong", "content": "full corrected content in string format" }\n` +
            `The "content" field must be the entire replacement content in string format ` +
            `(use the same format like the input — if it is JSON text, return JSON text).\n` +
            `If it fails but cannot be fixed, set pass to false and omit content.`);
    }
    // ── helpers ──────────────────────────────────────────────────────────
    #fileLabel(file) {
        return path.relative(this.repoRoot, file);
    }
    #lockKey(file) {
        return path.relative(this.repoRoot, file);
    }
    async #writeLock(lockKey, content) {
        let lockValue;
        if (typeof this.#lockValue === "number" || typeof this.#lockValue === "string") {
            lockValue = this.#lockValue;
        }
        const opts = {};
        if (lockValue !== undefined)
            opts.lockValue = lockValue;
        await lockWriteContent(this.name, lockKey, content, this.repoRoot, opts);
    }
    async #buildExtraContext(file) {
        if (this.#filesToRead.length === 0)
            return { value: "" };
        const extra = resolvePaths(this.#filesToRead, file, this.resolveTemplate.bind(this), this.repoRoot);
        if (extra.length === 0)
            return { value: "" };
        return buildFileContext(dedupePaths(extra), this.repoRoot);
    }
    async #callAndParse(prompt) {
        let reply;
        try {
            reply = await this.#provider.call(prompt, { cwd: this.repoRoot });
        }
        catch (err) {
            return { error: `${this.#provider.name} error: ${err instanceof Error ? err.message : String(err)}` };
        }
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            const value = JSON.parse(jsonMatch ? jsonMatch[0] : reply);
            return { value };
        }
        catch {
            return { error: `${this.#provider.name} returned invalid JSON: ${reply}` };
        }
    }
    static getHelp() {
        return {
            name: "AiPromptCheck",
            description: "Invokes an AI provider with a user-defined prompt to lint or fix a file. " +
                "Reads the whole file, sends it to the model, optionally writes back a modified version. " +
                "Non-deterministic; collapses to one whole-file finding per failed file.",
            options: "aiProvider — which AI provider to use: 'claude' (default) or 'gemini'; " +
                "lintPrompt — lint-specific instruction (string or array); " +
                "fixPrompt — fix-specific instruction (string or array); " +
                "filesToRead — additional context files (array of paths, supports {name_without_ext}/{name_with_ext}/{ext}/{dir} templates); " +
                "lock — cache AI verdicts per file in .ai-prompt-lock.json (boolean, default false); " +
                "lockValue — optional write mode, set to 1 to store universal lock entries instead of hashes",
        };
    }
}
