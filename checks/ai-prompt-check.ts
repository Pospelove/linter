import path from "path";
import fs from "fs/promises";
import { BaseCheck, type CheckResult } from "./base-check.js";
import { ClaudeProvider } from "../ai-providers/claude.js";
import { GeminiProvider } from "../ai-providers/gemini.js";
import { OpenAICompatibleProvider } from "../ai-providers/openai-compatible.js";
import { BaseAiProvider } from "../ai-providers/base-ai-provider.js";
import {
  coerce, coerceArray, standardTemplates, resolvePaths, dedupePaths,
  buildFileContext, lockfilePath, lockMatchesContent, lockWriteContent,
} from "./check-utils.js";

const AI_PROVIDERS: Record<string, new () => BaseAiProvider> = {
  claude: ClaudeProvider,
  gemini: GeminiProvider,
  openai: OpenAICompatibleProvider
};

/**
 * AI Prompt check.
 *
 * Operates on file content.
 *
 * Options (from linter-config.json):
 *   aiProvider     — which AI provider to use: "claude" (default) or "gemini"
 *   lintPrompt     — lint-specific instruction
 *   fixPrompt      — fix-specific instruction
 *   filesToRead    — additional files to include for context (array of paths)
 *                    Supports templates: {name_without_ext}, {name_with_ext},
 *                    {ext}, {dir}.
 *   lock           — if true, cache AI verdicts in .ai-prompt-lock.json
 *                    keyed by file and content hash.
 *   lockValue      — set to 1 to write universal lock entries instead of hashes.
 */
export class AiPromptCheck extends BaseCheck {
  #lintPrompt: string | undefined;
  #fixPrompt: string | undefined;
  #filesToRead: string[];
  #lock: boolean;
  #lockValue: unknown;
  #provider: BaseAiProvider;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);

    this.#lintPrompt = coerce(options["lintPrompt"]);
    this.#fixPrompt = coerce(options["fixPrompt"]);

    if (!this.#lintPrompt && !this.#fixPrompt) {
      throw new Error("AiPromptCheck requires at least one of: lintPrompt, fixPrompt");
    }

    this.#filesToRead = coerceArray(options["filesToRead"] ?? options["contextFiles"])
      .filter((f): f is string => typeof f === "string");
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

  override checkDeps(): boolean {
    return true;
  }

  override getTemplates(): Record<string, (ctx: Record<string, unknown>) => string> {
    return standardTemplates();
  }

  override async lint(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const instruction = this.#lintPrompt;
    if (!instruction) {
      return { status: "error", output: "No prompt configured for lint (set lintPrompt)" };
    }

    const content = await fs.readFile(file, "utf-8");

    const lockKey = this.#lockKey(file);
    if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
      return { status: "pass" };
    }

    const ctx = await this.#buildExtraContext(file);
    if (ctx.error) return { status: "error", output: ctx.error };

    const prompt = this.#buildLintPrompt(file, instruction, content, ctx.value || "");
    const verdict = await this.#callAndParse(prompt);
    if (verdict.error) return { status: "error", output: verdict.error };

    const lockPath = lockfilePath(this.repoRoot);
    if (verdict.value && verdict.value["pass"]) {
      if (this.#lock) {
        let lockValue: number | string | undefined;
        if (typeof this.#lockValue === "number" || typeof this.#lockValue === "string") {
          lockValue = this.#lockValue;
        }
        const opts: { lockValue?: number | string } = {};
        if (lockValue !== undefined) opts.lockValue = lockValue;
        await lockWriteContent(this.name, lockKey, content, this.repoRoot, opts);
      }
      return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
    }
    return { status: "fail", output: String(verdict.value?.["reason"] || "AI check failed (no reason provided)") };
  }

  override async fix(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const instruction = this.#fixPrompt;
    if (!instruction) {
      return { status: "error", output: "No prompt configured for fix (set fixPrompt)" };
    }

    const content = await fs.readFile(file, "utf-8");

    const lockKey = this.#lockKey(file);
    if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
      return { status: "pass" };
    }

    const ctx = await this.#buildExtraContext(file);
    if (ctx.error) return { status: "error", output: ctx.error };

    const prompt = this.#buildFixPrompt(file, instruction, content, ctx.value || "");
    const parsed = await this.#callAndParse(prompt);
    if (parsed.error) return { status: "error", output: parsed.error };
    const result = parsed.value;

    const lockPath = lockfilePath(this.repoRoot);

    if (!result || !result["changed"] || typeof result["content"] !== "string") {
      if (this.#lock) {
        let lockValue: number | string | undefined;
        if (typeof this.#lockValue === "number" || typeof this.#lockValue === "string") {
          lockValue = this.#lockValue;
        }
        const opts: { lockValue?: number | string } = {};
        if (lockValue !== undefined) opts.lockValue = lockValue;
        await lockWriteContent(this.name, lockKey, content, this.repoRoot, opts);
      }
      return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
    }

    if (result["content"] === content) {
      return { status: "pass", output: String(result["reason"] || "AI reported changes but content was identical") };
    }

    await fs.writeFile(file, result["content"], "utf-8");

    if (this.#lock) {
      let lockValue: number | string | undefined;
      if (typeof this.#lockValue === "number" || typeof this.#lockValue === "string") {
        lockValue = this.#lockValue;
      }
      const opts: { lockValue?: number | string } = {};
      if (lockValue !== undefined) opts.lockValue = lockValue;
      await lockWriteContent(this.name, lockKey, result["content"], this.repoRoot, opts);
    }

    return {
      status: "fixed",
      output: String(result["reason"] || "AI applied fixes"),
      ...(this.#lock && { extraFiles: [lockPath] }),
    };
  }

  override async lintAndFix(file: string, _deps: Record<string, unknown>): Promise<CheckResult | null> {
    if (!this.#lintPrompt || !this.#fixPrompt) return null;

    const content = await fs.readFile(file, "utf-8");

    const lockKey = this.#lockKey(file);
    if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
      return { status: "pass" };
    }

    const ctx = await this.#buildExtraContext(file);
    if (ctx.error) return { status: "error", output: ctx.error };

    const prompt = this.#buildLintAndFixPrompt(file, content, ctx.value || "");
    const parsed = await this.#callAndParse(prompt);
    if (parsed.error) return { status: "error", output: parsed.error };
    const result = parsed.value;

    const lockPath = lockfilePath(this.repoRoot);

    if (result && result["pass"]) {
      if (this.#lock) {
        let lockValue: number | string | undefined;
        if (typeof this.#lockValue === "number" || typeof this.#lockValue === "string") {
          lockValue = this.#lockValue;
        }
        const opts: { lockValue?: number | string } = {};
        if (lockValue !== undefined) opts.lockValue = lockValue;
        await lockWriteContent(this.name, lockKey, content, this.repoRoot, opts);
      }
      return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
    }

    if (!result || typeof result["content"] !== "string") {
      return { status: "fail", output: String(result?.["reason"] || "AI check failed and could not produce a fix") };
    }

    if (result["content"] === content) {
      return { status: "pass", output: String(result["reason"] || "AI reported changes but content was identical") };
    }
    
    await fs.writeFile(file, result["content"], "utf-8");

    if (this.#lock) {
      let lockValue: number | string | undefined;
      if (typeof this.#lockValue === "number" || typeof this.#lockValue === "string") {
        lockValue = this.#lockValue;
      }
      const opts: { lockValue?: number | string } = {};
      if (lockValue !== undefined) opts.lockValue = lockValue;
      await lockWriteContent(this.name, lockKey, result["content"], this.repoRoot, opts);
    }

    return {
      status: "fixed",
      output: String(result["reason"] || "AI applied fixes"),
      ...(this.#lock && { extraFiles: [lockPath] }),
    };
  }

  // ── prompt builders ──────────────────────────────────────────────────

  #buildLintPrompt(file: string, instruction: string, content: string, extraContext: string) {
    return (
      `You are a code review assistant integrated into a linter.\n` +
      `Item: ${this.#fileLabel(file)}\n` +
      `Instruction: ${instruction}\n\n` +
      `Content to review:\n${content}` +
      (extraContext ? `\n\n${extraContext}` : "") +
      `\n\nRespond with ONLY a JSON object (no markdown fences): ` +
      `{ "pass": true/false, "reason": "short explanation" }`
    );
  }

  #buildFixPrompt(file: string, instruction: string, content: string, extraContext: string) {
    return (
      `You are a code fixing assistant integrated into a linter.\n` +
      `Item to fix: ${this.#fileLabel(file)}\n` +
      `Instruction: ${instruction}\n\n` +
      `Content to fix:\n${content}` +
      (extraContext ? `\n\n${extraContext}` : "") +
      `\n\nRespond with ONLY a JSON object (no markdown fences): ` +
      `{ "changed": true/false, "reason": "short explanation", "content": "full new content in string format" }. ` +
      `The "content" field, when present, must be the entire replacement content in string format ` +
      `(use the same format like the input — if it is JSON text, return JSON text). ` +
      `If no changes are needed, set changed to false and omit content.`
    );
  }

  #buildLintAndFixPrompt(file: string, content: string, extraContext: string) {
    return (
      `You are a code review and fixing assistant integrated into a linter.\n` +
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
      `If it fails but cannot be fixed, set pass to false and omit content.`
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────

  #fileLabel(file: string) {
    return path.relative(this.repoRoot, file);
  }

  #lockKey(file: string) {
    return path.relative(this.repoRoot, file);
  }

  async #buildExtraContext(file: string) {
    if (this.#filesToRead.length === 0) return { value: "" };
    const extra = resolvePaths(this.#filesToRead, file, this.resolveTemplate.bind(this), this.repoRoot);
    if (extra.length === 0) return { value: "" };
    return buildFileContext(dedupePaths(extra), this.repoRoot);
  }

  async #callAndParse(prompt: string) {
    let reply: string;
    try {
      reply = await this.#provider.call(prompt, { cwd: this.repoRoot });
    } catch (err: unknown) {
      return { error: `${this.#provider.name} error: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      const value: Record<string, unknown> = JSON.parse(jsonMatch ? jsonMatch[0] : reply);
      return { value };
    } catch {
      return { error: `${this.#provider.name} returned invalid JSON: ${reply}` };
    }
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "AiPromptCheck",
      description:
        "Invokes an AI provider with a user-defined prompt. " +
        "Operates on file content.",
      options:
        "aiProvider — which AI provider to use: 'claude' (default) or 'gemini'; " +
        "lintPrompt — lint-specific instruction (string or array); " +
        "fixPrompt — fix-specific instruction (string or array); " +
        "filesToRead — additional context files (array of paths, supports {name_without_ext}/{name_with_ext}/{ext}/{dir} templates); " +
        "lock — cache AI verdicts per file in .ai-prompt-lock.json (boolean, default false); " +
        "lockValue — optional write mode, set to 1 to store universal lock entries instead of hashes",
    };
  }
}