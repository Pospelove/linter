# Per-finding workflow — implementation plan

Companion to [per-finding-workflow.md](./per-finding-workflow.md). The spec
is authoritative; this doc is the working checklist that turns the spec's
"Rollout" section into commit-level tasks.

## Ground rules

- If this plan disagrees with the spec, the spec wins — fix the plan.
- Two commits, in order. Do not combine phases.
- Run `yarn && yarn build && yarn test` before every commit; commit
  `dist/linter.mjs` alongside source (project convention — dist is not
  gitignored).
- Snapshot policy: existing snapshots must not move except where the spec
  explicitly permits (RegexCheck's console `output` string — see phase 2).
  If a snapshot drifts unexpectedly, stop and diagnose; don't refresh.

---

## Phase 1 — Delete virtual entries / expanders

Standalone commit. No new features. Every existing integration test must
pass unchanged. Isolates a large deletion diff from the per-finding
runtime that follows.

### Delete

- [ ] `entries/base-entry.ts`
- [ ] `entries/file-entry.ts`
- [ ] `entries/json-array-entry.ts`
- [ ] `expanders/base-expander.ts`
- [ ] `expanders/file-expander.ts`
- [ ] `expanders/json-array-expander.ts`

### `checks/base-check.ts`

- [ ] Remove `expander` field.
- [ ] Remove `expand()` and `setExpander()`.
- [ ] Remove `supportsInMemory`, `lintInMemory`, `fixInMemory`,
      `lintAndFixInMemory` (only useful in tandem with entries).

### `registry.ts`

- [ ] Remove `builtinExpanders` export.
- [ ] Remove the expander section from `--help` output.

### `linter.ts`

- [ ] Replace `runEntryLint` / `runEntryFix` helpers with direct
      `check.lint(file, ...)` / `check.fix(file, ...)` calls.
- [ ] Remove entry expansion loops; every check receives whole file paths.

### Config loader

- [ ] Reject any `expander` block in `linter-config.json` at load with:
      `<check>: 'expander' is no longer supported. See docs/per-finding-workflow.md.`
      Exit 2.

### Verification

- [ ] `yarn test` — all existing tests pass unchanged.
- [ ] `grep -rn "expander\|Entry\|Expander" --include="*.ts"` returns
      only test-fixture matches and the config-load error string.
- [ ] `yarn build`, commit `dist/linter.mjs`.

---

## Phase 2 — Per-finding runtime

Everything else in one cohesive commit: types, runner, CLI, config, PRD
generation, RegexCheck migration, and all integration tests from the
spec's Test Coverage section.

### `CheckFinding` type (in `checks/base-check.ts`)

- [ ] Declare `interface CheckFinding { message: string; snippet: string;
      startLine?: number; endLine?: number; }`.
- [ ] Extend `CheckResult` with optional `findings?: CheckFinding[]`.

### Runner (`linter.ts`)

- [ ] **Preflight**: `grep -rn 'status: *"pass"' checks/ | xargs -I{} grep -l 'output'`
      to confirm no existing check returns `pass` with an `output` shape
      that could accidentally trip the new invariant. Fix any it finds
      before enabling the invariant. (Expected: none today, but verify.)
- [ ] After a check returns, enforce the universal invariant:
  - `status == "pass" && findings?.length > 0` → runner error (impl bug).
  - `status in {"fail", "error"} && !findings?.length` → synthesize
    `[{ message: res.output ?? "check failed", snippet: "" }]`.
- [ ] Populate empty `snippet` from `startLine`/`endLine` by reading the
      file range (display only — count semantics never depend on snippet).
- [ ] Widen `failedPairs` to `Array<{ file, checkName, finding }>` where
      `finding` is always populated.

### CLI parser

Two new modes on `--lint`, both scoped to a single (check, file) pair.

`--expect-max <N>`:
- [ ] Accept on `--lint` only; combining with `--fix` → exit 2.
- [ ] Require exactly one `--checks` and exactly one `--files` → else exit 2.
- [ ] Reject negative or non-integer N → exit 2.
- [ ] Reject combination with `--output-prd` → exit 2.
- [ ] Reject combination with `--show` → exit 2.
- [ ] Exit 0 if `findings.length ≤ N`; exit 1 if `>`; exit 2 for
      unknown check / check-not-in-mode / missing file.
- [ ] Exit-1 output lists remaining findings (message + line range + snippet).

`--show <mode>`:
- [ ] Accept on `--lint` only; combining with `--fix` → exit 2.
- [ ] Require exactly one `--checks` and exactly one `--files` → else exit 2.
- [ ] Only accepted value: `first`. Anything else → exit 2 (reserved).
- [ ] Reject combination with `--expect-max` or `--output-prd` → exit 2.
- [ ] Output: one line of JSON — `{startLine, endLine, snippet, message}`,
      or the literal `null` if the file has zero findings. Exit 0 in both
      cases. Optional `unique: false` field in the widening edge case
      (see below).
- [ ] Ordering: findings sorted ascending by `startLine`; ties by the
      check's original emit order. Deterministic across runs given a
      deterministic check.
- [ ] Snippet widening algorithm (spec-mandated; implement exactly):
  1. Start with 2 lines of context above and 2 below the finding range,
     clipped at file boundaries.
  2. If the resulting substring occurs exactly once in the file, emit it
     and omit the `unique` field.
  3. Otherwise extend by 1 line above and 1 line below, retry. Cap: 20
     added lines above and 20 below (finding range always included in full).
  4. If uniqueness still not reached at the cap, emit the maximally
     widened snippet and include `"unique": false` in the JSON.
- [ ] Uniqueness check: exact-substring scan of the whole file. On very
      large files this is O(file size) per widening step; acceptable
      because `--show first` is a per-story query, not a hot path. No
      caching, no indexing — keep it simple.
- [ ] Widening is scoped to `--show` output only — never affects the
      on-disk snippet, the count, or `--expect-max`.

### Config loader

- [ ] Add `prd.storySplitMode: "per-file" | "per-finding"`, default
      `"per-file"`.
- [ ] Add `prd.findingsPerStory: number`, default `1`. Must be a
      positive integer.
- [ ] Hard errors at load (exit 2):
  - Unknown `storySplitMode` value (list valid values in stderr).
  - `per-finding` + `prd.group`.
  - `per-finding` + `filesPerStory != 1`.
  - `per-finding` + `findingsPerStory <= 0` or non-integer.
- [ ] Load-time warnings (stderr, exit 0):
  - `findingsPerStory` set with `storySplitMode` absent or `"per-file"`:
    `findingsPerStory is ignored when storySplitMode is not per-finding`.

### PRD generation (`buildPrd()`)

Per-file mode (default):
- [ ] Dedupe multiple findings per (file, check) back to one story before
      applying `filesPerStory`. Output byte-identical to today for every
      current fixture.

Per-finding mode:
- [ ] Group findings by (check, file).
- [ ] For each group with M findings, `N = findingsPerStory`,
      `S = ceil(M/N)`, emit S ordered stories K = 1..S:
  - Budget `Nₖ = min(N, M - (K-1)*N)`.
  - Acceptance criterion:
    `<baseCommand> --lint --checks <check> --files <file> --expect-max <max(0, M - K*N)>`.
- [ ] Ordering across the PRD: files alphabetical; within a file, checks
      in config order; within a (check, file), stories in K order.

### Title generator

- [ ] `M == 1` → `Fix <check> in <file>:<startLine>` (fall back to
      `Fix <check> in <file>` if no line info).
- [ ] `S == 1 && M > 1` → `Fix <check> in <file> (M findings)`.
- [ ] `S > 1` → `Fix <check> in <file> (story K of S; Nₖ findings)`.

### Description generator (default workflow script)

- [ ] Emit the spec's default body verbatim with substituted values for
      `<file>`, `<check>`, M, K, N, `Nₖ`, and `<max(0, M - K*N)>`:
  ```
  File:  <file>
  Check: <check>
  Findings at PRD generation: M. Fixed by prior stories: (K-1) * N.
  This story fixes exactly Nₖ finding(s). STOP after Nₖ iterations, even
  if more remain — later stories cover them. Any remaining finding may be
  addressed; findings are interchangeable.

  Repeat exactly Nₖ times:
    1. Locate the earliest remaining finding:
         <baseCmd> --lint --checks <check> --files <file> --show first
    2. Read only the affected range:
         Read(<file>, offset: startLine - 2, limit: (endLine - startLine) + 5)
    3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).

  Then verify:
    <baseCmd> --lint --checks <check> --files <file> --expect-max <expect>
  ```

### Template placeholders

- [ ] Existing: `{file}`, `{files}`, `{fileCount}`, `{check}`.
- [ ] New: `{findingCount}` (M), `{storyCount}` (S), `{storyIndex}` (K),
      `{storyBudget}` (Nₖ), `{expectMax}`, `{startLine}`, `{endLine}`,
      `{message}`, `{snippet}`, `{findings}`, `{workflow}` (full default
      body).

### RegexCheck migration

- [ ] Emit one `CheckFinding` per regex hit: `message` (the check's
      configured message), `snippet` (the matched line), `startLine`,
      `endLine` (both = the hit's line number).
- [ ] Keep the existing `output` string ("N hit(s):\n  line 1: ...")
      byte-identical.
- [ ] **Byte-identity gate**: immediately after the RegexCheck code
      change, run `yarn test --grep regex-process-env-ban` and assert
      zero snapshot diff. If it moves, revert the RegexCheck change and
      fix root cause before continuing. Do not proceed with a snapshot
      refresh without an explicit spec deviation callout.

### Integration tests to add (fixture per test)

Per-finding PRD generation:
- [ ] `per-finding-single` — 1 finding → 1 story, `--expect-max 0`.
- [ ] `per-finding-multi-n1` — 3 findings, N=1 → 3 stories,
      `--expect-max 2, 1, 0`. Descriptions say "fix 1, STOP".
- [ ] `per-finding-multi-nk-remainder` — 7 findings, N=3 → 3 stories,
      `--expect-max 4, 1, 0`. Story 3 budget = 1 (not 3).
- [ ] `per-finding-multi-nk-divisible` — 6 findings, N=3 → 2 stories,
      each budget 3, `--expect-max 3, 0`.
- [ ] `per-finding-fallback` — check without findings + per-finding
      mode → 1 synthetic finding per failed file (unaffected by
      `findingsPerStory`).
- [ ] `per-finding-sequential-drift` — running story K's criterion before
      story K-1 exits 1 loudly.

Config validation:
- [ ] `config-storysplit-unknown` — unknown value → exit 2.
- [ ] `config-per-finding-with-group` → exit 2.
- [ ] `config-per-finding-with-files-per-story` → exit 2.
- [ ] `config-findings-per-story-invalid` — 0 / negative / non-integer → exit 2.
- [ ] `config-findings-per-story-warning` — set in per-file mode → exit 0,
      warning on stderr.

`--expect-max`:
- [ ] `lint-expect-max-pass` — findings ≤ N → exit 0.
- [ ] `lint-expect-max-fail` — findings > N → exit 1, output lists remaining.
- [ ] `lint-expect-max-misuse` — one fixture per: `--fix` combo, 0 or 2
      `--checks`, 0 or 2 `--files`, negative N, non-integer N, combination
      with `--output-prd`, combination with `--show`, unknown check,
      check-not-in-mode, missing file.

`--show first`:
- [ ] `lint-show-first-json` — assert exact JSON shape on a multi-finding file.
- [ ] `lint-show-first-null` — file with no findings prints `null`, exit 0.
- [ ] `lint-show-first-widening-initial` — file where the 2+2 baseline is
      unique; assert JSON omits the `unique` field.
- [ ] `lint-show-first-widening-extended` — file where 2+2 is not unique
      but a wider window is; assert emitted snippet is exactly the
      smallest unique widening.
- [ ] `lint-show-first-widening-capped` — file with a deliberately
      repetitive block larger than the cap; assert JSON contains
      `"unique": false` and the snippet is the maximally widened window.
- [ ] `lint-show-first-determinism` — two runs produce byte-identical output.
- [ ] `lint-show-first-misuse` — one fixture per: `--fix` combo,
      `--expect-max` combo, `--output-prd` combo, 0 or 2 `--checks`, 0 or
      2 `--files`, `--show bogus`, unknown check, check-not-in-mode,
      missing file.

RegexCheck:
- [ ] `regex-emits-findings` — assert `CheckFinding[]` populated on a
      failing file (via a small custom fixture using a debug flag or via
      per-finding PRD output).

### Backward compat verification

- [ ] `yarn test` — every existing test still passes without snapshot
      updates: `regex-process-env-ban`, `prd-single-file-multi-hit`,
      `prd-two-files-two-stories`, `prd-no-failures`, all others.
- [ ] Every existing check (tsc, encoding, always-fail, ai-prompt,
      firecrawl, composite, custom, crlf) runs unchanged — no code touched
      outside RegexCheck.

### Build

- [ ] `yarn build`; commit `dist/linter.mjs`.

---

## Phase 3 — Follow-ups (shipped)

Landed after Phase 2:

- **Phase 2 gap fix**: `prd.storySplitMode` / `prd.findingsPerStory` on a
  **per-check** basis (as the spec always intended). Phase 2 only wired
  the top-level `prd` block; a check-level `prd.storySplitMode:
  "per-finding"` was silently ignored, so users with mixed-mode PRDs got
  a single deduped per-file story instead of per-finding stories. The
  effective mode for each check is now `checkPrd.storySplitMode ??
  topLevelPrd.storySplitMode ?? "per-file"`; same fallback for
  `findingsPerStory`. Per-check config is validated at load with the same
  hard-error rules as top-level (per-finding + group / filesPerStory != 1
  / findingsPerStory <= 0). New fixture: `prd-per-check-mode`.

- `tsc-check` emits one `CheckFinding` per compiler diagnostic; the
  human-readable `output` string is byte-identical to before, so no
  existing snapshot moves.
- `crlf-check` emits one finding per line that ends in `\r`; `output`
  remains the static string `contains CRLF line endings`.
- `encoding-check` emits an explicit finding at line 1 for BOMs, and one
  finding per offending line in ASCII-only mode. Whole-file classifiers
  (invalid UTF-8, wrong encoding) still rely on the runner's invariant to
  synthesize a single finding from `output`.
- `--show all` mode: prints a JSON array of every finding, each entry the
  same shape as `--show first` (with per-finding widening). Prints `[]`
  when the file has zero findings.
- `--json` for `--lint`: emits one structured JSON blob to stdout with
  `files[]` (per-file per-check results including `findings[]`) and
  `summary` counts. Informational logs are diverted to stderr so stdout
  stays parseable. Rejects `--fix`, `--expect-max`, `--show`, and
  `--output-prd`.
- Ralph runner integration: `ralph/CLAUDE.md` and `ralph/prompt.md` gained
  a `Per-finding stories` section that instructs the runner to re-query
  `--show first` on every iteration and respect the story's `STOP after N`
  bound.

Test fixtures added: `lint-show-all-basic`, `lint-show-all-empty`,
`lint-show-all-bogus`, `lint-json-basic`, `lint-json-misuse-fix`,
`lint-json-misuse-show`, `crlf-per-finding-show-all`,
`encoding-bom-finding`.

## Phase 4 — Follow-ups (open list)

Not planned in advance. Likely candidates once Phase 3 is in use:

- Migrate remaining whole-file encoding-check failure modes (invalid
  UTF-8, wrong-encoding classifiers) to include byte-offset -> line-number
  info so they emit precise findings instead of relying on the invariant
  synthesizer.
- `--json` schema versioning: freeze the shape and bump a `schemaVersion`
  field.
- `--expect-max` on multiple `--checks` / `--files` pairs (currently
  restricted to one pair).
- `--show <mode>` on multi-file input (currently one pair).

