/**
 * Base class for AI providers.
 * An AI provider sends a prompt and returns a text response.
 */
export class BaseAiProvider {
  /**
   * @returns {string} Human-readable name of the provider.
   */
  get name() {
    throw new Error("Not implemented: name");
  }

  /**
   * Check whether this provider's dependencies are available.
   * @returns {boolean}
   */
  checkDeps() {
    throw new Error("Not implemented: checkDeps");
  }

  /**
   * Send a prompt and return the AI's text response.
   * @param {string} prompt
   * @param {{ cwd?: string }} options
   * @returns {Promise<string>}
   */
  async call(prompt, options = {}) {
    throw new Error("Not implemented: call");
  }

  /**
   * Return help info for this provider class.
   * @returns {{ name: string, description: string }}
   */
  static getHelp() {
    return { name: "BaseAiProvider", description: "Abstract base class for AI providers." };
  }
}
