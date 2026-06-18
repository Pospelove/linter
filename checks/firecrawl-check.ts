import fs from "fs/promises";
import path from "path";
import { BaseCheck, CheckResult } from "./base-check.js";

interface ExtractUrlResult {
  error?: string;
  isUrlOnly?: boolean;
  value?: string;
}

interface FirecrawlResponse {
  success: boolean;
  error?: string;
  data?: {
    html?: string;
    markdown?: string;
  };
}

/**
 * Firecrawl check — scrapes a URL found in a file using the Firecrawl API
 * and writes the scraped content back to the file.
 *
 * This is a fix-only check. Lint mode reports "fail" when the file contains
 * only a URL (i.e. hasn't been scraped yet), or "pass" otherwise.
 *
 * Options (from linter-config.json):
 *   outputFormat — "markdown" (default) or "html"; controls Firecrawl output.
 *   apiKey       — Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var.
 *   apiUrl       — Firecrawl API base URL (default: https://api.firecrawl.dev).
 *   timeout      — request timeout in milliseconds (default: 60000).
 *
 * File format:
 *   The file must contain a URL on the first line (leading/trailing whitespace
 *   is trimmed). A bare URL means the file hasn't been scraped yet.
 *   After scraping, the file is overwritten with the scraped content.
 *
 * Fix mode:
 *   1. Read the file and extract the URL from the first line.
 *   2. Call the Firecrawl scrape API.
 *   3. Write the scraped content back to the file.
 */
export class FirecrawlCheck extends BaseCheck {
  #outputFormat: string;
  #apiKey: string | null;
  #apiUrl: string;
  #timeout: number;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    this.#outputFormat = typeof options["outputFormat"] === "string" ? options["outputFormat"] : "markdown";
    this.#apiKey = typeof options["apiKey"] === "string" ? options["apiKey"] : null;
    this.#apiUrl = (typeof options["apiUrl"] === "string" ? options["apiUrl"] : "https://api.firecrawl.dev").replace(/\/+$/, "");
    this.#timeout = typeof options["timeout"] === "number" ? options["timeout"] : 60_000;
  }

  override get name(): string {
    return "Firecrawl";
  }

  override checkDeps(): boolean {
    return true;
  }

  override async lint(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const url = await this.#extractUrl(file);
    if (url.error) {
      return { status: "error", output: url.error };
    }
    if (url.isUrlOnly) {
      return { status: "fail", output: `file contains unscraped URL: ${url.value} — run fix to scrape` };
    }
    return { status: "pass" };
  }

  override async fix(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    const url = await this.#extractUrl(file);
    if (url.error) {
      return { status: "error", output: url.error };
    }
    if (!url.isUrlOnly) {
      return { status: "pass" };
    }

    const apiKey = this.#resolveApiKey();
    if (!apiKey) {
      return {
        status: "error",
        output: "Firecrawl API key not configured. Set apiKey in check options or FIRECRAWL_API_KEY env var.",
      };
    }

    let scraped: string | undefined;
    try {
      scraped = await this.#scrape(url.value!, apiKey);
    } catch (err) {
      return { status: "error", output: `Firecrawl API error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!scraped) {
      return { status: "error", output: "Firecrawl returned empty content" };
    }

    await fs.writeFile(path.resolve(file), scraped, "utf-8");
    return { status: "fixed", output: `scraped ${url.value}` };
  }

  async #extractUrl(file: string): Promise<ExtractUrlResult> {
    let content: string;
    try {
      content = await fs.readFile(path.resolve(file), "utf-8");
    } catch (err) {
      return { error: `cannot read file: ${err instanceof Error ? err.message : String(err)}` };
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return { error: "file is empty" };
    }

    const lines = trimmed.split(/\r?\n/);
    const firstLine = (lines[0] || "").trim();

    try {
      const parsed = new URL(firstLine);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { error: `unsupported protocol: ${parsed.protocol}` };
      }
    } catch {
      return { isUrlOnly: false, value: firstLine };
    }

    // File is "URL-only" if the entire trimmed content is just the URL
    const isUrlOnly = trimmed === firstLine;
    return { isUrlOnly, value: firstLine };
  }

  #resolveApiKey(): string | null {
    return this.#apiKey || process.env['FIRECRAWL_API_KEY'] || null;
  }

  async #scrape(url: string, apiKey: string): Promise<string | undefined> {
    const endpoint = `${this.#apiUrl}/v1/scrape`;

    const formats = this.#outputFormat === "html" ? ["html"] : ["markdown"];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, formats }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
      }

      const data: FirecrawlResponse = await res.json();

      if (!data.success) {
        throw new Error(data.error || "scrape unsuccessful");
      }

      return this.#outputFormat === "html"
        ? data.data?.html
        : data.data?.markdown;
    } finally {
      clearTimeout(timer);
    }
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "FirecrawlCheck",
      description:
        "Scrapes a URL found in a file using the Firecrawl API and writes the result back. " +
        "Fix-only: lint reports whether the file still contains an unscraped URL.",
      options:
        "outputFormat — 'markdown' (default) or 'html'; " +
        "apiKey — Firecrawl API key (falls back to FIRECRAWL_API_KEY env var); " +
        "apiUrl — Firecrawl API base URL (default: https://api.firecrawl.dev); " +
        "timeout — request timeout in ms (default: 60000)",
    };
  }
}
