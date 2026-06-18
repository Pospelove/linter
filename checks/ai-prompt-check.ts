import path from "path";
import { BaseCheck } from "./base-check.js";
import { ClaudeProvider } from "../ai-providers/claude.js";
import { GeminiProvider } from "../ai-providers/gemini.js";
import { OpenAICompatibleProvider } from "../ai-providers/openai-compatible.js";
import {
  coerce, coerceArray, standardTemplates, resolvePaths, dedupePaths,
  buildFileContext, lockfilePath, lockMatchesContent, lockWriteContent,
} from "./check-utils.js";

const AI_PROVIDERS = {
  claude: ClaudeProvider,
  gemini: GeminiProvider,
  openai: OpenAICompatibleProvider
};

/**
 * AI Prompt check — pure string-in / string-out.
 *
 * Operates on a content string supplied by the entry (via entry.readContent()).
 * For a plain FileEntry that string is the whole file; for a virtual entry like
 * JsonArrayEntry it is just the slice (e.g. one JSON array element). The check
 * itself is oblivious — it never opens the source file, never knows what kind
 * of slice it received. Modified content is returned as a string and the runner
 * pipes it back through entry.writeBack().
 *
 * Options (from linter-config.json):
 *   aiProvider     — which AI provider to use: "claude" (default) or "gemini"
 *   lintPrompt     — lint-specific instruction
 *   fixPrompt      — fix-specific instruction
 *   filesToRead    — additional files to include as context (array of paths)
 *                    Supports templates: {name_without_ext}, {name_with_ext},
 *                    {ext}, {dir}.
 *   lock           — if true, cache AI verdicts per entry in .ai-prompt-lock.json
 *                    keyed by entry.id and content hash.
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

    this.#lintPrompt = coerce(options.lintPrompt);
    this.#fixPrompt = coerce(options.fixPrompt);

    if (!this.#lintPrompt && !this.#fixPrompt) {
      throw new Error("AiPromptCheck requires at least one of: lintPrompt, fixPrompt");
    }

    this.#filesToRead = coerceArray(options.filesToRead ?? options.contextFiles);
    this.#lock = !!options.lock;
    this.#lockValue = options.lockValue;

    const providerName = (options.aiProvider || "claude").toLowerCase();
    const ProviderClass = AI_PROVIDERS[providerName];
    if (!ProviderClass) {
      throw new Error(`Unknown aiProvider "${providerName}". Available: ${Object.keys(AI_PROVIDERS).join(", ")}`);
    }
    this.#provider = new ProviderClass();
  }

  get name() {
    const label = this.#lintPrompt || this.#fixPrompt;
    return `AI Prompt (${label.slice(0, 50)}${label.length > 50 ? "…" : ""})`;
  }

  checkDeps() {
    return true;
  }

  getTemplates() {
    return standardTemplates();
  }

  get supportsInMemory() {
    return true;
  }

  async lintInMemory(content, _deps, entry) {
    const instruction = this.#lintPrompt;
    if (!instruction) {
      return { status: "error", output: "No prompt configured for lint (set lintPrompt)" };
    }

    const lockKey = this.#lockKey(entry);
    if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
      return { status: "pass" };
    }

    const ctx = await this.#buildExtraContext(entry);
    if (ctx.error) return { status: "error", output: ctx.error };

    const prompt = this.#buildLintPrompt(entry, instruction, content, ctx.value);
    const verdict = await this.#callAndParse(prompt);
    if (verdict.error) return { status: "error", output: verdict.error };

    const lockPath = lockfilePath(this.repoRoot);
    if (verdict.value.pass) {
      if (this.#lock) await lockWriteContent(this.name, lockKey, content, this.repoRoot, { lockValue: this.#lockValue });
      return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
    }
    return { status: "fail", output: verdict.value.reason || "AI check failed (no reason provided)" };
  }

  async fixInMemory(content, _deps, entry) {
    const instruction = this.#fixPrompt;
    if (!instruction) {
      return { status: "error", output: "No prompt configured for fix (set fixPrompt)" };
    }

    const lockKey = this.#lockKey(entry);
    if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
      return { status: "pass" };
    }

    const ctx = await this.#buildExtraContext(entry);
    if (ctx.error) return { status: "error", output: ctx.error };

    const prompt = this.#buildFixPrompt(entry, instruction, content, ctx.value);
    const parsed = await this.#callAndParse(prompt);
    if (parsed.error) return { status: "error", output: parsed.error };
    const result = parsed.value;

    const lockPath = lockfilePath(this.repoRoot);

    if (!result.changed || typeof result.content !== "string") {
      if (this.#lock) await lockWriteContent(this.name, lockKey, content, this.repoRoot, { lockValue: this.#lockValue });
      return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
    }

    if (result.content === content) {
      return { status: "pass", output: result.reason || "AI reported changes but content was identical" };
    }

    if (this.#lock) await lockWriteContent(this.name, lockKey, result.content, this.repoRoot, { lockValue: this.#lockValue });

    return {
      status: "fixed",
      output: result.reason || "AI applied fixes",
      content: result.content,
      ...(this.#lock && { extraFiles: [lockPath] }),
    };
  }

  async lintAndFixInMemory(content, _deps, entry) {
    if (!this.#lintPrompt || !this.#fixPrompt) return null;

    const lockKey = this.#lockKey(entry);
    if (this.#lock && await lockMatchesContent(this.name, lockKey, content, this.repoRoot)) {
      return { status: "pass" };
    }

    const ctx = await this.#buildExtraContext(entry);
    if (ctx.error) return { status: "error", output: ctx.error };

    const prompt = this.#buildLintAndFixPrompt(entry, content, ctx.value);
    const parsed = await this.#callAndParse(prompt);
    if (parsed.error) return { status: "error", output: parsed.error };
    const result = parsed.value;

    const lockPath = lockfilePath(this.repoRoot);

    if (result.pass) {
      if (this.#lock) await lockWriteContent(this.name, lockKey, content, this.repoRoot, { lockValue: this.#lockValue });
      return { status: "pass", ...(this.#lock && { extraFiles: [lockPath] }) };
    }

    if (typeof result.content !== "string") {
      return { status: "fail", output: result.reason || "AI check failed and could not produce a fix" };
    }

    if (result.content === content) {
      return { status: "pass", output: result.reason || "AI reported changes but content was identical" };
    }

    if (this.#lock) await lockWriteContent(this.name, lockKey, result.content, this.repoRoot, { lockValue: this.#lockValue });

    return {
      status: "fixed",
      output: result.reason || "AI applied fixes",
      content: result.content,
      ...(this.#lock && { extraFiles: [lockPath] }),
    };
  }

  // ── prompt builders ──────────────────────────────────────────────────

  #buildLintPrompt(entry, instruction, content, extraContext) {
    return (
      `You are a code review assistant integrated into a linter.\n` +
      `Item: ${this.#entryLabel(entry)}\n` +
      `Instruction: ${instruction}\n\n` +
      `Content to review:\n${content}` +
      (extraContext ? `\n\n${extraContext}` : "") +
      `\n\nRespond with ONLY a JSON object (no markdown fences): ` +
      `{ "pass": true/false, "reason": "short explanation" }`
    );
  }

  #buildFixPrompt(entry, instruction, content, extraContext) {
    return (
      `You are a code fixing assistant integrated into a linter.\n` +
      `Item to fix: ${this.#entryLabel(entry)}\n` +
      `Instruction: ${instruction}\n\n` +
      `Content to fix:\n${content}` +
      (extraContext ? `\n\n${extraContext}` : "") +
      `\n\nRespond with ONLY a JSON object (no markdown fences): ` +
      `{ "changed": true/false, "reason": "short explanation", "content": "full new content as a string" }. ` +
      `The "content" field, when present, must be the entire replacement content as a single string ` +
      `(use the same format as the input — if it is JSON text, return JSON text). ` +
      `If no changes are needed, set changed to false and omit content.`
    );
  }

  #buildLintAndFixPrompt(entry, content, extraContext) {
    return (
      `You are a code review and fixing assistant integrated into a linter.\n` +
      `Item: ${this.#entryLabel(entry)}\n\n` +
      `Lint criteria: ${this.#lintPrompt}\n` +
      `Fix instruction: ${this.#fixPrompt}\n\n` +
      `Content:\n${content}` +
      (extraContext ? `\n\n${extraContext}` : "") +
      `\n\nFirst evaluate the content against the lint criteria.\n` +
      `If it PASSES, respond with ONLY a JSON object (no markdown fences):\n` +
      `{ "pass": true, "reason": "short explanation" }\n\n` +
      `If it FAILS, apply the fix instruction and respond with ONLY a JSON object (no markdown fences):\n` +
      `{ "pass": false, "reason": "short explanation of what was wrong", "content": "full corrected content as a string" }\n` +
      `The "content" field must be the entire replacement content as a single string ` +
      `(use the same format as the input — if it is JSON text, return JSON text).\n` +
      `If it fails but cannot be fixed, set pass to false and omit content.`
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────

  #entryLabel(entry) {
    if (!entry) return "(unknown)";
    if (entry.sourceFile) {
      const rel = path.relative(this.repoRoot, entry.sourceFile);
      const id = entry.id;
      return id && id !== entry.sourceFile ? `${rel} (${path.basename(id)})` : rel;
    }
    return entry.id || "(unknown)";
  }

  #lockKey(entry) {
    if (!entry?.sourceFile) return entry?.id ?? "(unknown)";
    const rel = path.relative(this.repoRoot, entry.sourceFile);
    if (!entry.isVirtual || !entry.id) return rel;
    const suffix = entry.id.startsWith(entry.sourceFile)
      ? entry.id.slice(entry.sourceFile.length)
      : `:${entry.id}`;
    return rel + suffix;
  }

  async #buildExtraContext(entry) {
    if (this.#filesToRead.length === 0) return { value: "" };
    const file = entry?.sourceFile ?? null;
    const extra = resolvePaths(this.#filesToRead, file, this.resolveTemplate.bind(this), this.repoRoot);
    if (extra.length === 0) return { value: "" };
    return buildFileContext(dedupePaths(extra), this.repoRoot);
  }

  async #callAndParse(prompt) {
    let reply;
    try {
      reply = await this.#provider.call(prompt, { cwd: this.repoRoot });
    } catch (err) {
      return { error: `${this.#provider.name} error: ${err.message}` };
    }
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      return { value: JSON.parse(jsonMatch ? jsonMatch[0] : reply) };
    } catch {
      return { error: `${this.#provider.name} returned invalid JSON: ${reply}` };
    }
  }

  static getHelp() {
    return {
      name: "AiPromptCheck",
      description:
        "Invokes an AI provider with a user-defined prompt. Pure string-in / string-out: " +
        "operates on whatever content the entry hands it (whole file via FileEntry, or a " +
        "virtual slice via JsonArrayExpander, etc.). The entry is responsible for slicing " +
        "and splicing; the check stays oblivious.",
      options:
        "aiProvider — which AI provider to use: 'claude' (default) or 'gemini'; " +
        "lintPrompt — lint-specific instruction (string or array); " +
        "fixPrompt — fix-specific instruction (string or array); " +
        "filesToRead — additional context files (array of paths, supports {name_without_ext}/{name_with_ext}/{ext}/{dir} templates); " +
        "lock — cache AI verdicts per entry in .ai-prompt-lock.json (boolean, default false); " +
        "lockValue — optional write mode, set to 1 to store universal lock entries instead of hashes",
    };
  }
}
