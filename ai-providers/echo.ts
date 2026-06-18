import { BaseAiProvider } from "./base-ai-provider.js";

/**
 * Echo AI provider — for testing only.
 *
 * Lint mode: always returns { "pass": true, "reason": "echo-ok" }
 * Fix mode:  always returns { "pass": true, "reason": "echo-ok" }
 *            (no files changed, so the original files come back untouched)
 *
 * Detects mode by sniffing for "fix" keyword in the prompt.
 */
export class EchoProvider extends BaseAiProvider {
  get name() {
    return "echo";
  }

  checkDeps() {
    return true;
  }

  async call(prompt, _options = {}) {
    const isFixMode = prompt.includes("fixing assistant") || prompt.includes("fix mode");
    if (isFixMode) {
      return JSON.stringify({ pass: true, reason: "echo-ok (no fix needed)" });
    }
    return JSON.stringify({ pass: true, reason: "echo-ok" });
  }

  static getHelp() {
    return {
      name: "EchoProvider",
      description: "Test provider that always returns pass:true. No AI calls made.",
    };
  }
}
