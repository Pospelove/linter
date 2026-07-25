# Per-finding workflow — implementation plan

Companion to [per-finding-workflow.md](./per-finding-workflow.md). Each step
below is scoped to be picked up by an independent Claude session with cold
context. Steps are ordered by dependency: every step lands on `main` green
(build + `yarn test` pass) before the next one begins.

**Ground rules for every step**

- Read `docs/per-finding-workflow.md` first; it is the source of truth. This
  plan only points at which parts of the spec each step implements.
- Run `yarn build` after code changes so `./dist` stays in sync (see
  `CLAUDE.md`). Run `yarn test` and get to green before committing.
- Keep the diff scoped to the step. Do not opportunistically refactor
  neighbouring code. If you notice something out of scope, leave a note in
  the PR description, not a code change.
- Each step lists **fixtures to add**. Fixture layout:
  `tests/integration/<name>/{fixture/,expected/,args.txt}` — see any existing
  test dir for the shape. Use `UPDATE_SNAPSHOTS=1 node tests/integration/run.mjs`
  once you're confident the observed output is correct.
- If a step's acceptance test is impossible to write cleanly without a helper
  that a later step would also want, add the helper here — but don't
  implement the later step's behavior.

---

## Step 1 — Delete virtual entries / expanders

**Spec section:** *Scope & assumptions*, bullet 1 (per-finding-workflow.md
lines 20-38); *Rollout* commit 1 (line 509).

**Why first:** Entries/expanders duplicate the fingerprint surface. Ripping
them out before the new machinery lands means later steps don't have to
reason about entry IDs vs file paths.

**Deletions:**

- `entries/base-entry.ts`, `entries/file-entry.ts`, `entries/json-array-entry.ts`
- `expanders/base-expander.ts`, `expanders/file-expander.ts`, `expanders/json-array-expander.ts`
- `expander` field, `expand()`, `setExpander()` on `BaseCheck` (see
  `checks/base-check.ts:48`, `70`, `85-102`)
- `supportsInMemory`, `lintInMemory`, `fixInMemory`, `lintAndFixInMemory`
  on `BaseCheck` (`checks/base-check.ts:213-265`)
- `builtinExpanders` in `registry.ts` and the corresponding help output
  (search for `builtinExpanders` and adjust `--help`)
- Entry expansion in `linter.ts`: `assertEntrySupported`, `runEntryLint`,
  `runEntryFix`, the `byEntry` grouping, and the per-entry code paths in the
  main lint/fix loops (`linter.ts:223-420`). Replace with direct
  `check.lint(file, ...)` / `check.fix(file, ...)` calls.
- `entry` parameter on `BaseCheck.lint` / `fix` / `lintAndFix` and all
  overrides.

**Add:** config-load error when any check entry in `linter-config.json`
contains an `expander` block. Message must include a link to
`docs/per-finding-workflow.md`.

**Tests:**

- Existing integration tests must pass unchanged. None currently use
  expanders — verify by grepping `tests/integration/**/linter-config.json`
  for `expander`.
- Add a fixture `config-expander-rejected` whose `linter-config.json` has an
  `expander` block; expected stdout/stderr shows the config-load error and
  non-zero exit code.

**Definition of done:** entries/, expanders/ directories gone; `grep -r
expander` in the repo returns only doc references, the new config-load
validation, and the new test fixture; `yarn build && yarn test` green.

---

## Step 2 — `CheckFinding` data model + synthetic-finding fallback

**Spec section:** *Data model* (lines 55-121); *Universal invariant* (lines
103-121); *Snippet population rule* (lines 87-102).

**Scope (internal only — no CLI changes yet):**

- Add `CheckFinding` interface and the optional `findings?: CheckFinding[]`
  field on `CheckResult` in `checks/base-check.ts`.
- Runner (`linter.ts`) normalizes every failed `(file, check)` result into
  at least one finding:
  - If `res.findings` is populated: use it as-is; run the snippet population
    rule (read file, fill blank snippets from line ranges).
  - If `res.status` is `"fail"` or `"error"` with no findings: synthesize
    `{ message: res.output ?? "check failed", snippet: "" }`.
  - If `res.status` is `"pass"` with `findings.length > 0`: throw (implementation
    bug).
- Widen the internal `failedPairs` shape to `Array<{ file, checkName,
  finding }>` where `finding` is always populated. This is the *Runtime
  shape changes* section (lines 402-409).
- `buildPrd()` in `linter.ts` continues to dedupe multiple findings for the
  same `(file, check)` back down to one story so per-file mode output stays
  byte-identical.

**Do NOT yet:**

- Compute fingerprints (Step 3).
- Migrate any check to populate `findings` (Step 4).
- Add CLI flags (Steps 5-7).

**Tests:**

- All existing snapshots (`regex-process-env-ban`, `prd-single-file-multi-hit`,
  `prd-two-files-two-stories`, `prd-no-failures`) must pass byte-identical
  — this is the invariant from *Backward compatibility* (lines 349-368).
- Add a unit-level integration fixture `finding-invariant-pass-with-findings`:
  a check that returns `status: pass, findings: [{...}]` triggers the
  runner's implementation-bug throw.

**Definition of done:** synthesized findings visible in `failedPairs` under
a debug log or via test, but no PRD/CLI output change.

---

## Step 3 — Fingerprint derivation + determinism test

**Spec section:** *Fingerprint* (lines 122-184).

**Scope:**

- Add one helper (e.g. `checks/finding-fingerprint.ts`) that:
  - Normalizes the snippet: `s.trim().replace(/\s+/g, " ")`.
  - Constructs `{ check, file, snippet }` in that fixed key order.
  - Normalizes the `file` value: `path.relative(repo, file).replace(/\\/g,
    "/")`.
  - Rejects UNC / `\\?\` / drive-relative paths with a clear error.
  - Encodes as `base64url(JSON.stringify(payload))`.
- Runner injects `finding.fingerprint` on every finding (real or
  synthesized) before it flows anywhere.

**Tests (in a new fixture `fingerprint-determinism`):**

- A check emits a known finding with a fixed snippet; the fixture snapshots
  the exact fingerprint value. Any drift in JSON serialization order, path
  normalization, or the empty-snippet path (for synthesized findings) trips
  the build.
- Cover both a real finding and a synthesized whole-file finding
  (empty-snippet path).

**Definition of done:** every finding at the point it reaches `buildPrd` has
a `.fingerprint`; the determinism snapshot is committed.

---

## Step 4 — Migrate `RegexCheck` to emit real findings

**Spec section:** *Backward compatibility → Console output* (lines 359-364);
*Rollout* commit 2 (line 517).

**Scope:**

- `checks/regex-check.ts` starts populating `CheckResult.findings`: one
  finding per regex hit, with `message`, `startLine`, `endLine`, and
  `snippet` = the matched line (or matched span if multiline).
- The `output` string ("N hit(s):\n  line 1: …") stays byte-identical so
  the `regex-process-env-ban` snapshot doesn't move.
- If the implementation absolutely has to tweak `output`, update the
  `regex-process-env-ban` expected snapshot in the same commit and note it
  in the PR description (spec allows this — line 361-363).

**Tests:**

- `regex-process-env-ban` passes (byte-identical output preferred; tweaked
  snapshot with justification allowed).
- All other snapshots unchanged.
- Add fixture `regex-emits-findings`: two regex hits in one file → assert
  via a debug/inspection path that two findings with two distinct
  fingerprints (or the same fingerprint if snippets normalize identical —
  see next step) are attached.

**Definition of done:** RegexCheck is now the reference implementation for
checks that opt into per-finding.

---

## Step 5 — `--lint --finding <fp>` for a single fingerprint

**Spec section:** *CLI: `--lint --finding`* (lines 186-222); exit-code table
(lines 209-216).

**Scope (single fingerprint only, no list, no `--expect-max` yet — treat as
implicit `--expect-max 0`):**

- Parse `--finding <fp>` in `linter.ts` arg handling.
- Mutually exclusive with `--files`, `--checks`, `--output-prd` — exit 2
  with the message from the spec (lines 218-222).
- Decode the base64url payload, extract `check` + `file`, resolve to the
  configured check for the current `--mode`. Handle:
  - Malformed base64 / JSON / missing keys → exit 2.
  - Check not in config or not enabled for `--mode` → exit 2 with "config
    drift" message.
  - File no longer in repo → exit 2 with "env drift" message.
- Run the check against the single file, collect its findings, count how
  many share the target fingerprint.
- Exit 0 if the count is 0; exit 1 otherwise, printing `message + range +
  snippet` for each remaining instance.

**Tests (fixture `lint-finding-single`):**

- Exit 0 when the fingerprint is resolved.
- Exit 1 with the remaining-instances output when it isn't.
- Exit 2 for each of: malformed base64, malformed JSON, missing key, unknown
  check, check disabled for mode, missing file.
- Exit 2 for `--lint --finding` combined with each of `--files`, `--checks`,
  `--output-prd`.

**Definition of done:** you can round-trip a fingerprint through the CLI.

---

## Step 6 — `--lint --finding <fp1>,<fp2>,...` + `--expect-max <N>`

**Spec section:** *CLI* (lines 186-216) — the list and `--expect-max` parts;
*Handling duplicate findings* (lines 411-441).

**Scope:**

- Accept a comma-separated fingerprint list. Each fingerprint may reference
  a different check/file; process them independently and aggregate the
  result (exit 1 if any is still failing, else 0). Exit 2 rules from Step 5
  still apply per-fingerprint.
- Parse `--expect-max <N>` (default 0). Only valid with a single
  fingerprint. Combined with a list → exit 2 with the invalid-usage message
  (line 216).
- Update the exit-1 output: "instance count > allowed" prints message,
  range, snippet for each remaining instance.

**Tests:**

- Fixture `lint-finding-list`: three fingerprints across two files, one
  still failing → exit 1 aggregate; all resolved → exit 0.
- Fixture `lint-finding-expect-max`: three identical findings, `--expect-max
  2` → exit 0; `--expect-max 1` → exit 1.
- Fixture `lint-finding-expect-max-misuse`: `--expect-max 1` + list → exit 2.

**Definition of done:** all `--lint --finding` shapes from the spec work.

---

## Step 7 — Reserve `--fix --finding` with explicit error

**Spec section:** *CLI: `--fix --finding`* (lines 224-236); *Non-goals*
bullet 1 (lines 490-494).

**Scope (tiny — kept separate to avoid muddying Step 6):**

- Parse `--fix --finding` at CLI level so it isn't rejected as unknown.
- Exit 2 with the exact message from the spec (lines 227-232).

**Tests:**

- Fixture `fix-finding-reserved`: single fingerprint and list forms both
  exit 2 with the reserved message.

**Definition of done:** flag is discoverable but errors loudly.

---

## Step 8 — `prd.storySplitMode: "per-finding"` — unique fingerprints

**Spec section:** *PRD: `prd.storySplitMode`* (lines 238-262); *per-finding
chunking* — unique cases only (lines 264-297); *Templates* (lines 331-347).

**Scope:**

- Add `prd.storySplitMode`, `prd.findingsPerStory`, `prd.filesPerStory` to
  the config schema.
- In `buildPrd`, when a check has `storySplitMode: "per-finding"`, group
  findings by fingerprint. For this step handle only the **unique-fingerprint
  case** (1 instance per fingerprint):
  - Pack greedily under `findingsPerStory` (default 1) and `filesPerStory`
    (default 1).
  - Emit acceptance criterion `<baseCommand> --lint --finding <fp1>,<fp2>,...`
    (implicit `--expect-max 0`).
  - Titles per spec:
    - singleton: `Fix <check> in <file>:<startLine>`
    - bundled same file: `Fix <check> in <file> (N findings)`
    - bundled multi-file: `Fix <check> in N files (M findings)`
- Description per finding: `message`, line range, raw `snippet`.
- Template placeholders (`{findingCount}`, `{startLine}`, `{endLine}`,
  `{message}`, `{snippet}`, `{fingerprint}`, `{findings}`) applied if the
  check sets `userStoryTitle` / `userStoryDescription`.
- Files processed in alphabetical order.

**Explicitly deferred to Step 9:** multi-instance fingerprints. If a
fingerprint has M>1 instances in this step, emit M identical unique-style
stories (temporary — Step 9 replaces this with ordered `--expect-max`
stories). Add a TODO comment pointing at Step 9.

**Tests:**

- Fixture `prd-per-finding-one-per-story`: RegexCheck with defaults →
  one story per finding, each with `--lint --finding <fp>`.
- Fixture `prd-per-finding-bundled`: `findingsPerStory: 2`, `filesPerStory:
  1`, 5 findings across 2 files → assert exact story count and titles.
- Fixture `prd-per-finding-fallback`: `AlwaysFailCheck` with
  `storySplitMode: "per-finding"` → one story per failed file (synthesized
  finding).
- Backward compat: `prd-single-file-multi-hit`, `prd-two-files-two-stories`,
  `prd-no-failures` still byte-identical.

**Definition of done:** per-finding PRDs for the common (unique) case
generated correctly.

---

## Step 9 — Multi-instance ordered stories + `--expect-max` acceptance criteria

**Spec section:** *per-finding chunking* — multi-instance case (lines
270-282); *Handling duplicate findings* (lines 411-441).

**Scope:**

- Replace the temporary Step 8 behavior for multi-instance fingerprints:
  - M instances → M singleton stories K=1..M, contiguous, in K order.
  - Story K acceptance criterion: `<baseCommand> --lint --finding <fp>
    --expect-max <M-K>`.
  - Title: `Fix <check> in <file> (instance <K> of <M>)`.
  - Description clarifies partial-fix semantics per spec (lines 313-318).
- Multi-instance stories always singleton; bundling caps
  (`findingsPerStory` / `filesPerStory`) do not apply.
- Ordering across the PRD (line 299-302): multi-instance stories for a
  given fingerprint contiguous and in K order; unique fingerprints appear
  after multi-instance stories for the same file; files alphabetical.
- Template placeholders `{instanceIndex}`, `{instanceCount}`, `{expectMax}`
  wired up.

**Tests:**

- Fixture `prd-per-finding-multi-instance`: file with 3 identical TODO
  snippets → 3 stories with `--expect-max 2,1,0`.
- Fixture `prd-per-finding-sequential-enforcement`: run US-002's criterion
  before US-001's fix has happened → exit 1 (proves out-of-order runs fail
  loudly).
- Fixture `prd-per-finding-mixed`: file with 3 identical TODOs + 2 unique
  findings → exactly the layout from the *Concrete scenario* (lines 421-429).

**Definition of done:** the "3 identical TODOs" scenario from the spec
works end-to-end.

---

## Step 10 — Config validation + interaction-matrix hard errors and warnings

**Spec section:** *Interaction matrix* (lines 371-390); scattered config
errors elsewhere in the spec.

**Scope (many small validations, one commit):**

- `storySplitMode: "per-finding"` + `prd.group` set → hard error at config
  load (also spec line 322-327).
- Unknown `storySplitMode` value → hard error listing valid values.
- `storySplitMode` absent (per-file) + `findingsPerStory` set → stderr
  warning "findingsPerStory is ignored when storySplitMode is not
  per-finding"; still succeeds.
- Confirm Step 1's `expander` config-load error is still active and its
  message points at `docs/per-finding-workflow.md`.

**Tests (one fixture per validation):**

- `config-per-finding-with-group` (hard error).
- `config-storysplit-unknown-value` (hard error).
- `config-findings-per-story-warning` (warning + succeeds).
- Confirm `config-expander-rejected` (from Step 1) still passes.

**Definition of done:** interaction-matrix table (lines 373-390) is exercised
by tests row-by-row.

---

## Cross-cutting: what's intentionally *not* here

These come from *Non-goals* (lines 489-503) and *Rollout* commit 3 (line
519) and should not be attempted as part of this plan:

- `--fix --finding` implementation. (Step 7 only reserves the flag.)
- Standalone `--extract-finding` / `--patch-finding`.
- Multi-check groups producing per-finding stories.
- Column/byte offsets inside a line.
- Per-finding for non-deterministic checks (`ai-prompt-check`,
  `firecrawl-check`). They keep the synthesized-whole-file behavior from
  Step 2.

---

## Suggested commit sequencing on `main`

Each step above → one PR → one squash commit on `main`. Keep the PR title
in the form `per-finding step N: <short summary>` so the log tells the
story linearly. Steps 1-4 are the risky ones (they touch every check
result); steps 5-10 are additive.
