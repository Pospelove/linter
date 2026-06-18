import OpenAI from "openai";
import { BaseAiProvider } from "./base-ai-provider.js";

/**
 * AI provider that talks to any OpenAI-compatible endpoint via the OpenAI SDK.
 */
export class OpenAICompatibleProvider extends BaseAiProvider {
  #client;
  #model;

  /**
   * @param {{ apiKey: string, baseURL?: string, model?: string }} options
   */
  constructor({ apiKey, baseURL, model } = {}) {
    super();
    this.#model = model || "gpt-4o";
    this.#client = new OpenAI({
      apiKey: apiKey || "sk-no-key",
      ...(baseURL ? { baseURL } : {}),
    });
  }

  get name() {
    return `OpenAI-compatible (${this.#model})`;
  }

  checkDeps() {
    return true;
  }

  /**
   * @param {string} prompt
   * @param {{ timeout?: number }} options
   * @returns {Promise<string>}
   */
  async call(prompt, options = {}) {
    const response = await this.#client.chat.completions.create(
      {
        model: this.#model,
        messages: [{ role: "user", content: prompt }],
      },
      options.timeout ? { timeout: options.timeout } : {},
    );

    return response.choices[0]?.message?.content?.trim() ?? "";
  }

  static getHelp() {
    return {
      name: "OpenAICompatibleProvider",
      description:
        "Talks to any OpenAI-compatible endpoint via the OpenAI SDK. " +
        "Pass apiKey, baseURL (optional), and model (optional) to the constructor.",
    };
  }
}
