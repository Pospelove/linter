import { spawn } from "child_process";
import { BaseAiProvider, type AiProviderOptions } from "./base-ai-provider.js";

/**
 * AI provider that invokes the Claude CLI (`claude --print`).
 */
export class ClaudeProvider extends BaseAiProvider {
  override get name(): string {
    return "Claude CLI";
  }

  override checkDeps(): boolean {
    return true;
  }

  /**
   * Send a prompt to `claude --print` and return the response.
   * @param {string} prompt
   * @param {AiProviderOptions} options
   * @returns {Promise<string>}
   */
  override async call(prompt: string, options: AiProviderOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["--print"];

      const proc = spawn("claude", args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (fn: () => void) => {
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

      proc.stdout.on("data", (data: Buffer | string) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer | string) => { stderr += data.toString(); });

      proc.on("error", (err: Error & { code?: string }) => {
        settle(() => {
          if (err.code === "ENOENT") {
            reject(new Error("claude CLI not found on PATH"));
          } else {
            reject(err);
          }
        });
      });

      proc.on("close", (code: number | null) => {
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

  static override getHelp(): { name: string; description: string } {
    return {
      name: "ClaudeProvider",
      description: "Invokes the Claude CLI (claude --print) to get AI responses.",
    };
  }
}
