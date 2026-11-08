import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { execFileSync, spawnSync } from "child_process";
import YAML, { parseAllDocuments, isMap, isSeq, isScalar, Scalar } from "yaml";
import { BaseCheck, CheckFinding, CheckResult } from "./base-check.js";

/**
 * FileSyncCheck: a value written in several files must be the same everywhere.
 * See docs/file-sync-check.md for the design.
 *
 * Options:
 *   name       — human label of the synced value (used in messages)
 *   leader     — source whose values are the truth (optional)
 *   followers  — sources that must agree with the leader; without a leader
 *                they are peers and every key must have one value across all
 *   sources    — alias of followers, reads better for peers
 *   fix        — false: --fix only reports (default true)
 *   fixCommand — shell command run by --fix instead of rewriting followers
 *   strict     — a follower key the leader lacks is a failure (default true)
 *
 * A source is { files: [globs], key?: string, <extractor> } where the
 * extractor is one of:
 *   regex: "<pattern with (?<value>) and optional (?<key>)>", regexFlags?: "i"
 *   json:  "a.*.b.<key>"   ("*" matches any key/index, "<key>" too and names the key)
 *   yaml:  "services.<key>.name"
 *   blobHash: true         (git blob hash of the file, key = basename w/o extension)
 *   command: "cmd"         (prints key<TAB>value<TAB>line; {file} is replaced
 *                           with the repo-relative path, or the path is appended)
 */

type ExtractorKind = "regex" | "json" | "yaml" | "blobHash" | "command";

interface SourceSpec {
  role: "leader" | "follower";
  index: number;
  globs: RegExp[];
  globText: string[];
  fixedKey: string | null;
  kind: ExtractorKind;
  regex: RegExp | null;
  pathSegments: string[];
  command: string;
}

interface Occurrence {
  source: SourceSpec;
  file: string; // absolute
  key: string;
  value: string;
  line: number;
  // Range of the value's text in the file, when it can be rewritten.
  range: [number, number] | null;
  encode: ((value: string) => string) | null;
}

interface Problem {
  // The occurrence that is wrong (follower or peer).
  occ: Occurrence;
  // The leader occurrence it must match, if any.
  leaderOcc: Occurrence | null;
  kind: "mismatch" | "unknownKey" | "peerConflict" | "leaderConflict";
  // Every occurrence of the key (peers / leader conflicts).
  all: Occurrence[];
}

interface Loaded {
  occurrences: Occurrence[];
  errors: string[];
  files: Set<string>;
}

const EXTRACTORS: ExtractorKind[] = ["regex", "json", "yaml", "blobHash", "command"];

export class FileSyncCheck extends BaseCheck {
  #label: string;
  #leader: SourceSpec | null;
  #followers: SourceSpec[];
  #fix: boolean;
  #fixCommand: string | null;
  #strict: boolean;

  constructor(repoRoot: string, options: Record<string, unknown> = {}) {
    super(repoRoot, options);
    this.name = "File Sync Check";
    this.#label = typeof options["name"] === "string" ? options["name"] : "synced value";

    const leader = options["leader"];
    this.#leader = leader == null ? null : parseSource(leader, "leader", 0);

    const followersRaw = options["followers"] ?? options["sources"];
    if (!Array.isArray(followersRaw) || followersRaw.length === 0) {
      throw new Error("FileSyncCheck requires a non-empty 'followers' (or 'sources') array");
    }
    this.#followers = followersRaw.map((s: unknown, i: number) => parseSource(s, "follower", i));

    this.#fix = options["fix"] !== false;
    this.#fixCommand = typeof options["fixCommand"] === "string" ? options["fixCommand"] : null;
    this.#strict = options["strict"] !== false;
  }

  get #sources(): SourceSpec[] {
    return this.#leader ? [this.#leader, ...this.#followers] : this.#followers;
  }

  #rel(file: string): string {
    return path.relative(this.repoRoot, file).replace(/\\/g, "/");
  }

  #matches(src: SourceSpec, file: string): boolean {
    const rel = this.#rel(file);
    return src.globs.some((g) => g.test(rel));
  }

  override async appliesTo(file: string): Promise<boolean> {
    if (!(await super.appliesTo(file))) return false;
    const abs = path.resolve(this.repoRoot, file);
    return this.#sources.some((s) => this.#matches(s, abs));
  }

  #listRepoFiles(): string[] {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: this.repoRoot,
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return Array.from(new Set(out.split("\0").filter(Boolean)));
  }

  async #load(): Promise<Loaded> {
    const repoFiles = this.#listRepoFiles();
    const occurrences: Occurrence[] = [];
    const errors: string[] = [];
    const files = new Set<string>();

    for (const src of this.#sources) {
      const matched = repoFiles.filter((rel) => src.globs.some((g) => g.test(rel))).sort();
      for (const rel of matched) {
        const abs = path.resolve(this.repoRoot, rel);
        let buf: Buffer;
        try {
          buf = await fs.readFile(abs);
        } catch {
          continue; // deleted in the working tree
        }
        files.add(abs);
        try {
          occurrences.push(...this.#extract(src, abs, buf));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${rel}: ${msg}`);
        }
      }
    }
    return { occurrences, errors, files };
  }

  #extract(src: SourceSpec, file: string, buf: Buffer): Occurrence[] {
    const text = buf.toString("utf-8");
    const base = { source: src, file };
    const withKey = (key: string | null): string => {
      const k = key ?? src.fixedKey;
      if (k == null) throw new Error(`no key: the extractor yields none and the source has no 'key'`);
      return k;
    };

    switch (src.kind) {
      case "blobHash": {
        const hash = createHash("sha1")
          .update(`blob ${buf.length}\0`)
          .update(buf)
          .digest("hex");
        const key = src.fixedKey ?? path.basename(file, path.extname(file));
        return [{ ...base, key, value: hash, line: 1, range: null, encode: null }];
      }
      case "regex": {
        const re = new RegExp(src.regex!.source, src.regex!.flags);
        const res: Occurrence[] = [];
        const lineStarts = lineStartsOf(text);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) re.lastIndex++;
          const value = m.groups?.["value"];
          const range = m.indices?.groups?.["value"];
          if (value === undefined || !range) continue;
          res.push({
            ...base,
            key: withKey(m.groups?.["key"] ?? null),
            value,
            line: lineOf(lineStarts, range[0]),
            range: [range[0], range[1]],
            encode: (v) => v,
          });
        }
        return res;
      }
      case "json": {
        const root = parseJsonWithRanges(text);
        const lineStarts = lineStartsOf(text);
        const res: Occurrence[] = [];
        walkPath(root, src.pathSegments, null, jsonChildren, (node, key) => {
          const isString = node.kind === "string";
          res.push({
            ...base,
            key: withKey(key),
            value: isString ? String(node.value) : text.slice(node.start, node.end),
            line: lineOf(lineStarts, node.start),
            range: node.kind === "object" || node.kind === "array" ? null : [node.start, node.end],
            encode: (v) => (isString || !isJsonLiteral(v) ? JSON.stringify(v) : v),
          });
        });
        return res;
      }
      case "yaml": {
        const lineStarts = lineStartsOf(text);
        const res: Occurrence[] = [];
        for (const doc of parseAllDocuments(text)) {
          if ("errors" in doc && doc.errors.length > 0) {
            throw new Error(`invalid YAML: ${doc.errors[0]!.message}`);
          }
          walkPath(doc.contents, src.pathSegments, null, yamlChildren, (node, key) => {
            if (!isScalar(node) || !node.range) {
              res.push({ ...base, key: withKey(key), value: JSON.stringify(nodeToJs(node)), line: lineOf(lineStarts, nodeStart(node)), range: null, encode: null });
              return;
            }
            const scalar: Scalar = node;
            const r = scalar.range!;
            res.push({
              ...base,
              key: withKey(key),
              value: scalar.value == null ? "" : String(scalar.value),
              line: lineOf(lineStarts, r[0]),
              range: [r[0], r[1]],
              encode: (v) => encodeYamlScalar(v, scalar.type, scalar.value),
            });
          });
        }
        return res;
      }
      case "command": {
        const rel = this.#rel(file);
        const cmd = src.command.includes("{file}")
          ? src.command.replaceAll("{file}", shellQuote(rel))
          : `${src.command} ${shellQuote(rel)}`;
        const r = spawnSync(cmd, { cwd: this.repoRoot, shell: true, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
        if (r.status !== 0) {
          throw new Error(`command failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
        }
        const res: Occurrence[] = [];
        for (const raw of r.stdout.split(/\r?\n/)) {
          if (!raw) continue;
          const [key, value, line] = raw.split("\t");
          if (key === undefined || value === undefined) {
            throw new Error(`command printed a line that is not key<TAB>value<TAB>line: ${raw}`);
          }
          res.push({ ...base, key: key || withKey(null), value, line: Number(line) || 1, range: null, encode: null });
        }
        return res;
      }
    }
  }

  #problems(loaded: Loaded): Problem[] {
    const problems: Problem[] = [];
    const byKey = new Map<string, Occurrence[]>();
    for (const o of loaded.occurrences) {
      const list = byKey.get(o.key) ?? [];
      list.push(o);
      byKey.set(o.key, list);
    }

    for (const [, all] of byKey) {
      if (this.#leader) {
        const leaders = all.filter((o) => o.source.role === "leader");
        const followers = all.filter((o) => o.source.role === "follower");
        const leaderValues = new Set(leaders.map((o) => o.value));
        if (leaderValues.size > 1) {
          for (const occ of leaders) problems.push({ occ, leaderOcc: null, kind: "leaderConflict", all: leaders });
          continue;
        }
        const leaderOcc = leaders[0] ?? null;
        for (const occ of followers) {
          if (!leaderOcc) {
            if (this.#strict) problems.push({ occ, leaderOcc: null, kind: "unknownKey", all });
          } else if (occ.value !== leaderOcc.value) {
            problems.push({ occ, leaderOcc, kind: "mismatch", all });
          }
        }
      } else {
        const values = new Set(all.map((o) => o.value));
        if (values.size > 1) {
          for (const occ of all) problems.push({ occ, leaderOcc: null, kind: "peerConflict", all });
        }
      }
    }
    return problems;
  }

  /** Problems that the given file is involved in. */
  #problemsFor(problems: Problem[], file: string): Problem[] {
    const isLeaderFile = !!this.#leader && this.#matches(this.#leader, file);
    return problems.filter((p) => {
      if (p.occ.file === file) return true;
      if (p.kind === "peerConflict" || p.kind === "leaderConflict") return p.all.some((o) => o.file === file);
      if (p.kind === "mismatch") return p.leaderOcc?.file === file;
      // unknownKey: a leader change (e.g. a rename) is what made it unknown.
      return isLeaderFile;
    });
  }

  #where(o: Occurrence): string {
    return `${this.#rel(o.file)}:${o.line}`;
  }

  async #snippet(o: Occurrence): Promise<string> {
    if (o.source.kind === "blobHash") return `${this.#rel(o.file)} (blob ${o.value})`;
    try {
      const lines = (await fs.readFile(o.file, "utf-8")).split("\n");
      const s = lines[o.line - 1] ?? "";
      return s.replace(/\r$/, "") || `${o.key}: ${o.value}`;
    } catch {
      return `${o.key}: ${o.value}`;
    }
  }

  #describe(p: Problem): string {
    const { occ } = p;
    switch (p.kind) {
      case "mismatch":
        return `${this.#where(occ)}: ${occ.key} is ${JSON.stringify(occ.value)}, leader ${this.#where(p.leaderOcc!)} has ${JSON.stringify(p.leaderOcc!.value)}`;
      case "unknownKey":
        return `${this.#where(occ)}: refers to \`${occ.key}\`, and no leader has it`;
      case "leaderConflict":
      case "peerConflict": {
        const vals = p.all.map((o) => `${this.#where(o)} = ${JSON.stringify(o.value)}`).join(", ");
        const who = p.kind === "leaderConflict" ? "leader copies of" : "copies of";
        return `${this.#where(occ)}: ${who} \`${occ.key}\` disagree: ${vals}`;
      }
    }
  }

  async #result(problems: Problem[], file: string, loadErrors: string[]): Promise<CheckResult> {
    if (loadErrors.length > 0) {
      return { status: "error", output: `${this.#label}: cannot extract values:\n${loadErrors.map((e) => `  ${e}`).join("\n")}` };
    }
    // Conflicts are listed once per key, not once per copy, when seen from another file.
    const seen = new Set<string>();
    const shown = problems.filter((p) => {
      if (p.kind !== "peerConflict" && p.kind !== "leaderConflict") return true;
      const own = p.occ.file === file;
      const id = `${p.kind}\0${p.occ.key}`;
      if (own) return true;
      if (seen.has(id) || p.all.some((o) => o.file === file)) return false;
      seen.add(id);
      return true;
    });
    if (shown.length === 0) return { status: "pass" };

    const findings: CheckFinding[] = [];
    const lines: string[] = [];
    for (const p of shown) {
      const msg = this.#describe(p);
      lines.push(`  ${msg}`);
      const finding: CheckFinding = { message: `${this.#label}: ${msg}`, snippet: await this.#snippet(p.occ) };
      if (p.occ.file === file && p.occ.source.kind !== "blobHash") {
        finding.startLine = p.occ.line;
        finding.endLine = p.occ.line;
      }
      findings.push(finding);
    }
    return {
      status: "fail",
      output: `${this.#label}: ${shown.length} copy(ies) out of sync:\n${lines.join("\n")}`,
      findings,
    };
  }

  override async lint(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    try {
      const abs = path.resolve(this.repoRoot, file);
      const loaded = await this.#load();
      return this.#result(this.#problemsFor(this.#problems(loaded), abs), abs, loaded.errors);
    } catch (err: unknown) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }

  override async fix(file: string, _deps: Record<string, unknown>): Promise<CheckResult> {
    try {
      const abs = path.resolve(this.repoRoot, file);
      const before = await this.#load();
      if (before.errors.length > 0) return this.#result([], abs, before.errors);
      const mine = this.#problemsFor(this.#problems(before), abs);
      if (mine.length === 0) return { status: "pass" };
      if (!this.#fix || !this.#leader) return this.#result(mine, abs, []);

      const snapshot = await readAll(before.files);
      let note: string | undefined;

      if (this.#fixCommand) {
        const r = spawnSync(this.#fixCommand, { cwd: this.repoRoot, shell: true, encoding: "utf-8" });
        if (r.status !== 0) {
          return { status: "error", output: `fixCommand failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}` };
        }
        note = `ran: ${this.#fixCommand}`;
      } else {
        await this.#rewrite(mine);
      }

      const after = await this.#load();
      const changed: string[] = [];
      for (const f of new Set([...before.files, ...after.files])) {
        let now: string | null = null;
        try { now = await fs.readFile(f, "utf-8"); } catch { now = null; }
        if (now !== (snapshot.get(f) ?? null)) changed.push(f);
      }
      const remaining = this.#problemsFor(this.#problems(after), abs);
      if (remaining.length > 0) {
        const res = await this.#result(remaining, abs, after.errors);
        return { ...res, extraFiles: changed };
      }
      const res: CheckResult = { status: "fixed", extraFiles: changed };
      if (note) res.output = note;
      return res;
    } catch (err: unknown) {
      return { status: "error", output: err instanceof Error ? err.message : String(err) };
    }
  }

  async #rewrite(problems: Problem[]): Promise<void> {
    const edits = new Map<string, { range: [number, number]; text: string }[]>();
    for (const p of problems) {
      if (p.kind !== "mismatch" || !p.occ.range || !p.occ.encode) continue;
      const list = edits.get(p.occ.file) ?? [];
      if (!list.some((e) => e.range[0] === p.occ.range![0])) {
        list.push({ range: p.occ.range, text: p.occ.encode(p.leaderOcc!.value) });
      }
      edits.set(p.occ.file, list);
    }
    for (const [file, list] of edits) {
      // Ranges are UTF-16 offsets into the decoded text.
      let text = await fs.readFile(file, "utf-8");
      list.sort((a, b) => b.range[0] - a.range[0]);
      for (const e of list) text = text.slice(0, e.range[0]) + e.text + text.slice(e.range[1]);
      await fs.writeFile(file, text, "utf-8");
    }
  }

  static override getHelp(): { name: string; description: string; options: string } {
    return {
      name: "FileSyncCheck",
      description:
        "A value written in several files must be the same everywhere. Followers must match the leader; without a leader, all sources are peers. --fix rewrites followers, runs fixCommand, or only reports (fix: false).",
      options:
        'name, leader, followers (or sources): { "files": [globs], "key"?, one of "regex" | "json" | "yaml" | "blobHash" | "command" }; fix, fixCommand, strict',
    };
  }
}

// ── source parsing ──────────────────────────────────────────────────

function parseSource(raw: unknown, role: "leader" | "follower", index: number): SourceSpec {
  const where = role === "leader" ? "leader" : `followers[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`FileSyncCheck: ${where} must be an object`);
  }
  const obj: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const files = obj["files"];
  const globText = (Array.isArray(files) ? files : typeof files === "string" ? [files] : []).map((f) => String(f));
  if (globText.length === 0) throw new Error(`FileSyncCheck: ${where}.files must list at least one glob`);

  const kinds = EXTRACTORS.filter((k) => obj[k] !== undefined && obj[k] !== false);
  if (kinds.length !== 1) {
    throw new Error(`FileSyncCheck: ${where} needs exactly one extractor of ${EXTRACTORS.join(", ")}`);
  }
  const kind = kinds[0]!;
  const fixedKey = obj["key"] == null ? null : String(obj["key"]);

  let regex: RegExp | null = null;
  let pathSegments: string[] = [];
  let command = "";
  if (kind === "regex") {
    const extra = typeof obj["regexFlags"] === "string" ? obj["regexFlags"] : "";
    const flags = Array.from(new Set(`gdm${extra}`.split(""))).join("");
    regex = new RegExp(String(obj["regex"]), flags);
    if (!/\(\?<value>/.test(regex.source)) throw new Error(`FileSyncCheck: ${where}.regex needs a (?<value>...) group`);
    if (!/\(\?<key>/.test(regex.source) && fixedKey == null) {
      throw new Error(`FileSyncCheck: ${where} needs a (?<key>...) group or a 'key'`);
    }
  } else if (kind === "json" || kind === "yaml") {
    pathSegments = String(obj[kind]).split(".");
    const keyed = pathSegments.filter((s) => s === "<key>").length;
    if (keyed > 1) throw new Error(`FileSyncCheck: ${where}.${kind} may name <key> only once`);
    if (keyed === 0 && fixedKey == null) throw new Error(`FileSyncCheck: ${where} needs <key> in the path or a 'key'`);
  } else if (kind === "command") {
    command = String(obj["command"]);
  }

  return { role, index, globs: globText.map(globToRegExp), globText, fixedKey, kind, regex, pathSegments, command };
}

/** Glob to RegExp over repo-relative forward-slash paths: **, *, ?, {a,b}. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) { re += "\\{"; continue; }
      re += "(?:" + g.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

// ── path walking (shared by json and yaml) ──────────────────────────

type Children<N> = (node: N) => Array<[string, N]> | null;

function walkPath<N>(node: N, segs: string[], key: string | null, children: Children<N>, emit: (node: N, key: string | null) => void): void {
  if (segs.length === 0) {
    emit(node, key);
    return;
  }
  const [seg, ...rest] = segs;
  const kids = children(node);
  if (!kids) return;
  for (const [k, child] of kids) {
    if (seg === "*" || seg === "<key>" || seg === k) {
      walkPath(child, rest, seg === "<key>" ? k : key, children, emit);
    }
  }
}

// ── JSON with value ranges ──────────────────────────────────────────

interface JsonNode {
  kind: "object" | "array" | "string" | "number" | "literal";
  start: number;
  end: number;
  value?: unknown;
  entries?: Array<[string, JsonNode]>;
}

const jsonChildren: Children<JsonNode> = (n) => n.entries ?? null;

function parseJsonWithRanges(text: string): JsonNode {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const fail = (what: string): never => {
    const line = text.slice(0, i).split("\n").length;
    throw new Error(`invalid JSON at line ${line}: ${what}`);
  };
  const str = (): JsonNode => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail("unterminated string");
    i++;
    return { kind: "string", start, end: i, value: JSON.parse(text.slice(start, i)) };
  };
  const val = (): JsonNode => {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: Array<[string, JsonNode]> = [];
      ws();
      if (text[i] === "}") { i++; return { kind: "object", start, end: i, entries }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a key");
        const k = String(str().value);
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        entries.push([k, val()]);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return { kind: "object", start, end: i, entries }; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const entries: Array<[string, JsonNode]> = [];
      ws();
      if (text[i] === "]") { i++; return { kind: "array", start, end: i, entries }; }
      for (;;) {
        entries.push([String(entries.length), val()]);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return { kind: "array", start, end: i, entries }; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) return fail("unexpected token");
    i += m[0].length;
    return { kind: /^[-\d]/.test(m[0]) ? "number" : "literal", start, end: i };
  };
  const root = val();
  ws();
  if (i < text.length) fail("trailing characters");
  return root;
}

function isJsonLiteral(v: string): boolean {
  return /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/.test(v);
}

// ── YAML helpers ────────────────────────────────────────────────────

const yamlChildren: Children<unknown> = (n) => {
  if (isMap(n)) {
    return n.items.map((pair): [string, unknown] => {
      const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      return [k, pair.value];
    });
  }
  if (isSeq(n)) return n.items.map((item, idx): [string, unknown] => [String(idx), item]);
  return null;
};

function nodeStart(n: unknown): number {
  if (n && typeof n === "object" && "range" in n && Array.isArray(n.range)) return Number(n.range[0]) || 0;
  return 0;
}

function nodeToJs(n: unknown): unknown {
  if (n && typeof n === "object" && "toJSON" in n && typeof n.toJSON === "function") return n.toJSON();
  return n;
}

function encodeYamlScalar(v: string, type: string | undefined, original: unknown): string {
  if (type === "QUOTE_DOUBLE") return JSON.stringify(v);
  if (type === "QUOTE_SINGLE") return `'${v.replace(/'/g, "''")}'`;
  // Plain: keep it plain only when it reads back to the same value of the same type.
  if (!/[\r\n]/.test(v)) {
    try {
      const back: unknown = YAML.parse(v);
      if (back !== null && typeof back !== "object" && String(back) === v && typeof back === typeof original) return v;
    } catch {
      // not valid plain YAML
    }
  }
  return JSON.stringify(v);
}

// ── small utils ─────────────────────────────────────────────────────

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function shellQuote(s: string): string {
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function readAll(files: Set<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of files) {
    try { map.set(f, await fs.readFile(f, "utf-8")); } catch { /* gone */ }
  }
  return map;
}
