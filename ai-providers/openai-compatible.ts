import OpenAI from "openai";
import { BaseAiProvider, type AiProviderOptions } from "./base-ai-provider.js";

/**
 * AI provider that talks to any OpenAI-compatible endpoint via the OpenAI SDK.
 */
export class OpenAICompatibleProvider extends BaseAiProvider {
  #client: OpenAI;
  #model: string;

  /**
   * @param {{ apiKey?: string, baseURL?: string, model?: string }} options
   */
  constructor({ apiKey, baseURL, model }: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    super();
    this.#model = model || "gpt-4o";
    this.#client = new OpenAI({
      apiKey: apiKey || "sk-no-key",
      ...(baseURL ? { baseURL } : {}),
    });
  }

  override get name(): string {
    return `OpenAI-compatible (${this.#model})`;
  }

  override checkDeps(): boolean {
    return true;
  }

  /**
   * @param {string} prompt
   * @param {AiProviderOptions} options
   * @returns {Promise<string>}
   */
  override async call(prompt: string, options: AiProviderOptions = {}): Promise<string> {
    const response = await this.#client.chat.completions.create(
      {
        model: this.#model,
        messages: [{ role: "user", content: prompt }],
      },
      options.timeout ? { timeout: options.timeout } : {},
    );

    return response.choices[0]?.message?.content?.trim() ?? "";
  }

  static override getHelp(): { name: string; description: string } {
    return {
      name: "OpenAICompatibleProvider",
      description:
        "Talks to any OpenAI-compatible endpoint via the OpenAI SDK. " +
        "Pass apiKey, baseURL (optional), and model (optional) to the constructor.",
    };
  }
}
