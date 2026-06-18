/**
 * Base class for file sources.
 * A file source determines which files to process.
 */
export class BaseFileSource {
  public name: string = "Unnamed Source";
  protected repoRoot: string;
  protected options: Record<string, unknown>;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    this.repoRoot = repoRoot;
    this.options = options;
  }

  /**
   * Resolve the list of absolute file paths to process.
   * @param {object} context - { args: string[] } CLI args for parametric sources.
   * @returns {Promise<string[]>} Absolute paths.
   */
  async resolve(_context: { args: string[] }): Promise<string[]> {
    throw new Error("Not implemented: resolve");
  }

  /**
   * Return help info for this file source class.
   * Subclasses should override to provide specific details.
   * @returns {{ name: string, description: string, options: string }}
   */
  static getHelp() {
    return { name: "BaseFileSource", description: "Abstract base class for file sources.", options: "" };
  }
}
