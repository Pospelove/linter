import { spawn } from "child_process";
import { BaseAiProvider } from "./base-ai-provider.js";

/**
 * AI provider that invokes the Claude CLI (`claude --print`).
 */
export class ClaudeProvider extends BaseAiProvider {
  get name() {
    return "Claude CLI";
  }

  checkDeps() {
    return true;
  }

  /**
   * Send a prompt to `claude --print` and return the response.
   * @param {string} prompt
   * @param {{ cwd?: string }} options
   * @returns {Promise<string>}
   */
  async call(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const args = ["--print"];

      const proc = spawn("claude", args, {
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
            settle(() => reject(new Error(`claude CLI timed out after ${options.timeout}ms`)));
          }, options.timeout)
        : null;

      proc.stdout.on("data", (data) => { stdout += data; });
      proc.stderr.on("data", (data) => { stderr += data; });

      proc.on("error", (err) => {
        settle(() => {
          if (err.code === "ENOENT") {
            reject(new Error("claude CLI not found on PATH"));
          } else {
            reject(err);
          }
        });
      });

      proc.on("close", (code) => {
        settle(() => {
          if (code !== 0) {
            const parts = [`claude exited with code ${code}`];
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
      name: "ClaudeProvider",
      description: "Invokes the Claude CLI (claude --print) to get AI responses.",
    };
  }
}
