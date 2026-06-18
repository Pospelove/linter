export interface AiProviderOptions {
  cwd?: string;
  timeout?: number;
}

/**
 * Base class for AI providers.
 * An AI provider sends a prompt and returns a text response.
 */
export class BaseAiProvider {
  /**
   * @returns {string} Human-readable name of the provider.
   */
  get name(): string {
    throw new Error("Not implemented: name");
  }

  /**
   * Check whether this provider's dependencies are available.
   * @returns {boolean}
   */
  checkDeps(): boolean {
    throw new Error("Not implemented: checkDeps");
  }

  /**
   * Send a prompt and return the AI's text response.
   * @param {string} _prompt
   * @param {AiProviderOptions} _options
   * @returns {Promise<string>}
   */
  async call(_prompt: string, _options: AiProviderOptions = {}): Promise<string> {
    throw new Error("Not implemented: call");
  }

  /**
   * Return help info for this provider class.
   * @returns {{ name: string, description: string }}
   */
  static getHelp(): { name: string; description: string } {
    return { name: "BaseAiProvider", description: "Abstract base class for AI providers." };
  }
}
