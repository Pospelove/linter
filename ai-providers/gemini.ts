import { spawn } from "child_process";
import { BaseAiProvider } from "./base-ai-provider.js";

/**
 * AI provider that invokes the Gemini CLI (`gemini -p`).
 */
export class GeminiProvider extends BaseAiProvider {
  #model;

  constructor(model) {
    super();
    this.#model = model || null;
  }

  get name() {
    return this.#model ? `Gemini CLI (${this.#model})` : "Gemini CLI";
  }

  checkDeps() {
    return true;
  }

  /**
   * Send a prompt to `gemini` in headless mode (-p) and return the response.
   * Uses -m to select model when configured.
   * @param {string} prompt
   * @param {{ cwd?: string }} options
   * @returns {Promise<string>}
   */
  async call(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const args = [];
      if (this.#model) args.push("-m", this.#model);

      const proc = spawn("gemini", args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      const timer = options.timeout
        ? setTimeout(() => {
            proc.kill();
            settle(() => reject(new Error(`gemini CLI timed out after ${options.timeout}ms`)));
          }, options.timeout)
        : null;

      proc.stdout.on("data", (data) => { stdout += data; });
      proc.stderr.on("data", (data) => { stderr += data; });

      proc.on("error", (err) => {
        settle(() => {
          if (err.code === "ENOENT") {
            reject(new Error("gemini CLI not found on PATH"));
          } else {
            reject(err);
          }
        });
      });

      proc.on("close", (code) => {
        settle(() => {
          if (code !== 0) {
            const parts = [`gemini exited with code ${code}`];
            if (stderr.trim()) parts.push(`stderr: ${stderr.trim()}`);
            if (stdout.trim()) parts.push(`stdout: ${stdout.trim()}`);
            reject(new Error(parts.join("\n")));
            return;
          }
          resolve(stdout.trim());
        });
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  static getHelp() {
    return {
      name: "GeminiProvider",
      description: "Invokes the Gemini CLI via stdin in headless mode. Supports model selection via constructor.",
    };
  }
}
