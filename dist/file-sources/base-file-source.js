/**
 * Base class for file sources.
 * A file source determines which files to process.
 */
export class BaseFileSource {
    name = "Unnamed Source";
    repoRoot;
    options;
    constructor(repoRoot, options = {}) {
        this.repoRoot = repoRoot;
        this.options = options;
    }
    /**
     * Resolve the list of absolute file paths to process.
     * @param {object} context - { args: string[] } CLI args for parametric sources.
     * @returns {Promise<string[]>} Absolute paths.
     */
    async resolve(_context) {
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
