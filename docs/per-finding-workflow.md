# Per-finding workflow

## Motivation

Today a check reports 0 or 1 result per file. A file with 100 regex hits produces
one `[FAIL]` line and — critically — one `--output-prd` user story. That is:

- Coarse for tracking (can't see "37 of 100 fixed").
- Blocks the ralph/PRD flow on large files: a single story covering 100 errors
  can't be handed to a model that doesn't fit the whole file in context.
- Forces authors to split giant files just to shrink the fix unit.

Goal: let a check emit N findings per file and let each finding become its own
PRD story. Downstream verification runs entirely on **counts** — no per-finding
identifiers, no snippet hashes, no positional tracking.

## Scope & assumptions

- **Virtual entries / expanders are deleted as part of this feature.** The
  prior `JsonArrayEntry` / `JsonArrayExpander` machinery was an earlier
  attempt at the same problem (fine-grained fix targets inside a larger
  file); findings supersede it. This spec's implementation removes:
  - `entries/base-entry.ts`, `entries/file-entry.ts`, `entries/json-array-entry.ts`
  - `expanders/base-expander.ts`, `expanders/file-expander.ts`, `expanders/json-array-expander.ts`
  - `expander` field and `expand()` / `setExpander()` on `BaseCheck`
  - `supportsInMemory`, `lintInMemory`, `fixInMemory`, `lintAndFixInMemory`
    on `BaseCheck` (only useful in tandem with virtual entries)
  - `builtinExpanders` in `registry.ts` and the corresponding help output
  - Entry expansion in the runner: every check now processes whole files
    directly. `runEntryLint` / `runEntryFix` helpers become plain
    `check.lint(file, ...)` / `check.fix(file, ...)` calls.
  - Any `expander` block in `linter-config.json` is a config-load error with
    a pointer to this doc.
- **Checks may be non-deterministic.** Non-deterministic checks (AI-based,
  network-based — `ai-prompt-check`, `firecrawl-check`) SHOULD NOT populate
  `findings` themselves; the exact set drifts run-to-run and the count is
  meaningless. If one fails, the runner synthesizes exactly one whole-file
  finding as described in "Universal invariant" below — same granularity
  as today.
- **File-based entries only.** Every finding refers to a file path relative
  to the repo root. No entry IDs, no slice suffixes.
- **Execution is strictly sequential.** PRD stories are always processed in
  ID order (`US-001` first, `US-002` next, …). No reordering, no interleaving,
  no parallel work across stories. The multi-story `--expect-max` mechanic
  requires this: when story K is being verified, stories 1..K-1 must already
  be complete, otherwise the finding count is wrong. Parallel execution is
  out of scope; if we ever want it, design fresh, not retrofit.
- **No per-finding identity.** Findings inside a (check, file) are fungible:
  the runner counts them, it doesn't track which is which. Verifying a
  specific finding by identity across runs is deliberately out of scope.
  A content-hash approach was considered and abandoned — snippet-based
  hashes silently drift when a fix mutates the snippet without removing
  the underlying problem, producing false-green verifications. Counting
  sidesteps this at the cost of not being able to say "this exact finding
  was resolved" — only "at least K findings were resolved since PRD generation."

## Data model

### `CheckFinding`

A check may include `findings` on its `CheckResult`:

```ts
interface CheckFinding {
  message: string;          // one-line human summary
  snippet: string;          // the offending text; "" for whole-file findings
  startLine?: number;       // 1-based; omit for whole-file findings
  endLine?: number;         // 1-based, inclusive; defaults to startLine
}

interface CheckResult {
  status: CheckStatus;
  output?: string;          // existing: freeform text for console display
  extraFiles?: string[];    // existing
  findings?: CheckFinding[]; // NEW
}
```

`snippet` and line numbers are **display only**. They render in stderr and
in story descriptions so a human (or model) can locate the finding, but
nothing programmatic depends on their exact content — the runner never
matches them across runs. `snippet` can span multiple lines and is not
truncated; if a check would emit a 10,000-line snippet, that's a check
design problem: narrow the range.

`output` and `findings` coexist. `output` drives the console `[FAIL]` message
(unchanged). `findings` is the machine-readable stream that feeds PRD, and
its **length** is what `--expect-max` compares against.

### Snippet population (display only)

- If a finding has `startLine` (and/or `endLine`) but `snippet` is empty or
  missing, the runner reads the file and populates `snippet` from that line
  range so descriptions have something to show. Not required for correctness.
- Whole-file findings (no line info) may have empty `snippet`.
- If a check emits `snippet` verbatim, it is respected.

Because snippet is never fingerprinted or matched, there is no ambiguity
concern with duplicates — three identical `TODO` snippets are simply three
findings, counted as three.

### Universal invariant: findings.length == 0 iff status == "pass"

The runner enforces this so downstream code never needs a special case:

- If a check returns `status: "fail"` (or `"error"`) with no `findings`, the
  runner synthesizes a single implicit finding:
  ```
  { message: res.output ?? "check failed", snippet: "" }
  ```
  Represents "the whole file failed this check." Counts as 1 for
  `--expect-max` purposes.
- If a check returns `status: "pass"` with `findings.length > 0`, the runner
  rejects it (implementation bug).

Consequence: legacy checks (`tsc-check`, `encoding-check`, `always-fail`, …)
automatically participate in the per-finding workflow without code changes.
They collapse to one synthetic finding per failed file — matching today's
story-per-file granularity. To emit finer findings (e.g. one per tsc error),
the check must be upgraded to populate `findings` itself.

## CLI: `--lint --expect-max <N>`

New flag on `--lint`. Combined with `--checks <check>` and `--files <file>`
(each naming exactly one), it passes iff the check produces at most `N`
findings on the file.

Constraints:

- `--expect-max` requires `--lint`. Using it with `--fix` exits 2.
- `--expect-max` requires `--checks` to name exactly one check AND `--files`
  to name exactly one file. Zero or multiple of either exits 2.
- `N` must be a non-negative integer; negative or non-numeric exits 2.
- Without `--expect-max`, `--lint` behaves exactly as today.

Exit codes:

| Situation | Exit | Meaning |
|---|---|---|
| Check produces ≤ N findings on the file | 0 | Story done. |
| Check produces > N findings on the file | 1 | Still failing. Prints message + range + snippet for each remaining finding. |
| `--checks` names an unknown check, or the check is not enabled for the current `--mode` | 2 | Config drift. |
| `--files` names a missing file | 2 | Env drift. |
| `--expect-max` combined with `--fix`, or with zero/multiple checks or files, or a bad N | 2 | Invalid usage. |
| `--lint --expect-max` combined with `--output-prd` | 2 | Invalid usage (per-finding verification is not a valid moment to regenerate a PRD). |

### `--fix --expect-max` and per-finding fix

Not implemented. Fixing a specific finding by identity is impossible under
this model (findings have no identity). `--fix` continues to apply the
check's whole-file fix path as today. Combining `--fix` with `--expect-max`
exits 2 with an explicit message.

## PRD: `prd.storySplitMode`

New per-check option in `linter-config.json`:

```json
{
  "name": "process-env-ban",
  "export": "RegexCheck",
  "modes": ["manual", "hook", "ci"],
  "options": { "pattern": "\\bprocess\\.env\\b", "message": "..." },
  "prd": {
    "storySplitMode": "per-finding",
    "filesPerStory": 1
  }
}
```

`storySplitMode` values:

- `"per-file"` (default): current behavior. One story per (file-chunk × check).
  `filesPerStory` chunks files. Per-finding count is ignored.
- `"per-finding"`: for each (check, file) that produces M findings, emit M
  ordered stories. `filesPerStory` MUST be 1 in this mode (default); other
  values are a config-load error.

### `"per-finding"` chunking

For each (check, file) pair with M ≥ 1 findings, emit M ordered stories
K = 1..M:

- Story K's acceptance criterion:
  `<baseCommand> --lint --checks <check> --files <file> --expect-max <M-K>`
- Story K passes iff the file currently has at most (M-K) findings for this
  check.

Because execution is sequential, story K only runs after stories 1..K-1
passed — i.e. after at least K-1 findings were already fixed. Story K then
requires at least one more finding to be resolved. Which one doesn't
matter: findings are fungible.

Ordering: for a given (check, file), the M stories are contiguous and in K
order (US-001, US-002, …, US-00M). Files are processed in alphabetical
order; within a file, checks are processed in config order. Multi-file
runs concatenate per-(check, file) groups.

Story fields in per-finding mode:

- **title**:
  - Single-finding file (M = 1): `Fix <check> in <file>:<startLine>`
    (line from the sole finding when present; falls back to just the file).
  - Multi-finding file (M > 1), story K of M:
    `Fix <check> in <file> (K of M findings)`.
- **description**: for every finding in the file at PRD-generation time,
  includes `message`, line range, and raw `snippet` — the model gets the
  full inventory so it can pick any one to address. For multi-finding files
  the description notes explicitly that (a) line numbers may have shifted
  since PRD generation, (b) any remaining finding is fair game — findings
  are interchangeable and the story only requires the total to drop by one.
- **acceptanceCriteria**:
  `[<baseCommand> --lint --checks <check> --files <file> --expect-max <M-K>]`.

### Interaction with `prd.group`

Not defined. If a check with `prd.group` also sets `storySplitMode:
"per-finding"`, the runner errors at config load. Cross that bridge when
we need it.

### Templates in `per-finding` mode

`userStoryTitle` and `userStoryDescription` templates work in per-finding
mode with these placeholders (in addition to existing `{file}`, `{files}`,
`{fileCount}`, `{check}`):

- `{findingCount}` — M, total findings for the (check, file) at PRD generation.
- `{instanceIndex}` — K in "K of M" (1-based).
- `{expectMax}` — value passed to `--expect-max` in the acceptance criterion
  (`M-K`).
- `{startLine}`, `{endLine}` — from the first finding in the file.
- `{message}`, `{snippet}` — from the first finding.
- `{findings}` — all findings rendered as `line N: <snippet>` joined by newlines.

If unset, the built-in defaults above apply.

## Backward compatibility

### Invariants (no config change → no behavior change)

- **All existing integration tests pass unchanged**: `regex-process-env-ban`,
  `prd-single-file-multi-hit`, `prd-two-files-two-stories`, `prd-no-failures`.
- **`--output-prd` is byte-identical** to today when no check sets
  `prd.storySplitMode: "per-finding"`. Same story count, titles, descriptions,
  acceptance criteria, priorities.
- **Console output is byte-identical** for every check *except potentially
  `RegexCheck`*. RegexCheck starts populating `findings` internally; its
  `output` string ("N hit(s):\n  line 1: …") is intended to stay unchanged,
  but if the implementation ends up tweaking it, the `regex-process-env-ban`
  snapshot is updated in the same commit and treated as intentional.
- **`--lint` / `--fix` exit codes and semantics unchanged** when
  `--expect-max` is absent.
- **All existing check implementations compile and run unchanged** —
  `CheckResult.findings` is optional; the runner synthesizes it when omitted.
- **`linter-config.json` schema is purely additive**: new field
  (`prd.storySplitMode`) has a safe default; unknown fields aren't rejected
  today and aren't now.

### Interaction matrix

| Combination | Behavior |
|---|---|
| `storySplitMode` absent or `"per-file"` | Today's behavior, exactly. Per-finding count ignored for PRD purposes; `filesPerStory` chunks files. |
| `storySplitMode: "per-finding"` + check emits real findings | For each (check, file) with M findings, emit M ordered stories with `--expect-max M-1..0`. |
| `storySplitMode: "per-finding"` + check emits no findings (tsc, encoding, etc.) | Runner injects one synthetic finding per failed file → one story per failed file per check. Same granularity as today. No warning. |
| `storySplitMode: "per-finding"` + `filesPerStory != 1` | **Hard error at config load.** Per-finding stories are always single-(check, file). |
| `storySplitMode: "per-finding"` + `prd.group` | **Hard error at config load.** Not defined; punt until needed. |
| `storySplitMode: "per-finding"` + `userStoryTitle` / `userStoryDescription` | Templates applied with per-finding placeholders (see PRD section). |
| `storySplitMode: "per-finding"` + `additionalAcceptanceCriteria` | Appended to every per-finding story (same as today for per-file). |
| Any check with an `expander` in config (regardless of `storySplitMode`) | **Hard error at config load** — expanders are removed by this feature. See Scope. |
| Unknown `storySplitMode` value | Hard error at config load with the list of valid values. |
| `--lint --expect-max N` without exactly one `--checks` and exactly one `--files` | Exit 2. |
| `--lint --expect-max N` with `--fix` | Exit 2. |
| `--lint --expect-max N` with a negative or non-integer N | Exit 2. |
| `--lint --expect-max` + `--output-prd` | Exit 2. |
| `--lint --expect-max` referencing an unknown check, or a check not enabled for `--mode` | Exit 2 (config drift). |
| `--lint --expect-max` referencing a missing file | Exit 2 (env drift). |

### Downstream PRD consumers

- PRD JSON schema unchanged: `{ project, branchName, description, userStories:
  UserStory[] }` with `UserStory` having `id, title, description,
  acceptanceCriteria, priority, passes, notes`.
- Story IDs remain sequential (`US-001`, `US-002`, …).
- The only visible change for consumers of a check that opts into per-finding:
  more stories, and acceptance-criteria commands that add `--expect-max <N>`
  to the familiar `--lint --checks X --files Y` shape.

### Runtime shape changes (internal, not user-visible)

- `failedPairs` widens to `Array<{ file, checkName, finding }>` where
  `finding` is always populated (real or synthesized). Not part of any public
  API; touches `linter.ts` only.
- `buildPrd()` receives the wider `failedPairs`. In per-file mode it dedupes
  multiple findings for the same (file, check) back down to one story before
  applying `filesPerStory` — producing today's output exactly.

### Handling multi-finding files (no drift)

The runner counts findings per (check, file). With M findings and M ordered
stories:

- Story K's criterion is `--expect-max <M-K>`. It passes iff the file
  currently has at most (M-K) findings for the check.
- Because execution is strictly sequential (see Scope), story K only runs
  after stories 1..K-1 passed — i.e. after at least K-1 findings were fixed.
  Story K then requires at least one more fix.

Concrete scenario: file has three `TODO` comments plus two other
findings, all reported by the same check → M = 5. PRD:

- US-001: `--expect-max 4`.
- US-002: `--expect-max 3`.
- US-003: `--expect-max 2`.
- US-004: `--expect-max 1`.
- US-005: `--expect-max 0`.

Ralph processes in order. On US-001 the model removes any one finding
(any of the TODOs, any of the others — they're indistinguishable to the
runner). Four remain → `--expect-max 4` passes. Continue until US-005
requires zero. If ralph tries to run US-003 before US-001, its criterion
`--expect-max 2` fails against 5 remaining findings and exits 1.
Sequential order enforces itself.

## Test coverage

Integration tests that must exist by end of phase 1:

- **Backward compat** (locks today's behavior — must pass unchanged):
  - `regex-process-env-ban` — console output. Snapshot may be updated in the
    same commit if RegexCheck's `output` string is intentionally tweaked;
    treat it as intentional change, not regression.
  - `prd-single-file-multi-hit`, `prd-two-files-two-stories`,
    `prd-no-failures` — PRD output for the default (per-file) mode.
- **Per-finding, single-finding file**: `storySplitMode: "per-finding"`, file
  with one finding → PRD has one story with `--expect-max 0`.
- **Per-finding, multi-finding file**: file with three findings → PRD has
  three stories with acceptance criteria `--expect-max 2, 1, 0`.
- **Per-finding fallback**: check that never emits real findings (use an
  `AlwaysFailCheck` fixture) with `storySplitMode: "per-finding"`. Runner
  synthesizes one whole-file finding per failed file → one story per file
  with `--expect-max 0`.
- **Sequential enforcement**: running a multi-finding story's criterion out
  of order (story 3 before story 1) fails loudly (exit 1) with the expected
  "N > expect-max" style message.
- **Config validation errors** (each in its own fixture; assert config-load
  exit code and stderr message):
  - `storySplitMode: "per-finding"` + `prd.group` set.
  - `storySplitMode: "per-finding"` + `filesPerStory: 2`.
  - `storySplitMode: "per-finding"` + `expander` set.
  - Unknown `storySplitMode` value.
- **`--lint --expect-max N`**:
  - Exit 0 when findings.length ≤ N.
  - Exit 1 when findings.length > N (assert message/range/snippet for
    remaining findings in output).
  - Exit 2 for: `--fix` combination, zero or multiple `--checks`, zero or
    multiple `--files`, negative N, non-integer N, unknown check,
    check-not-enabled-for-mode, missing file, combination with `--output-prd`.

## Non-goals (for now)

- **Cross-file bundling of per-finding stories.** `filesPerStory > 1` in
  per-finding mode is out of scope; every per-finding story targets exactly
  one (check, file).
- **`--fix --expect-max <N>`.** Fix cannot target a specific finding under
  this model (findings have no identity). Combination exits 2.
- Multi-check groups producing per-finding stories.
- Column/byte-offset precision inside a line. Add later if a check needs it.
- ~~Retiring virtual entries~~ — done as part of this feature (see Scope).
- **Per-finding granularity for non-deterministic checks** (ai-prompt,
  firecrawl): they emit at most one synthesized whole-file finding per
  failure. Counting doesn't give useful stories when the count itself
  drifts run-to-run.
- **Verifying a specific finding by identity.** Attempted with content-hash
  fingerprints; abandoned because snippet edits (from the fix itself or from
  incidental reformats) silently drift the hash without necessarily removing
  the underlying problem, producing false-green verifications. Count-based
  `--expect-max` sidesteps this at the cost of not being able to say "this
  exact finding was resolved" — only "at least K findings were resolved."

## Rollout

Commits after this doc lands:

1. **Delete virtual entries / expanders** (see Scope for the full removal
   list). Standalone commit so the diff is unambiguous. Existing tests must
   still pass — none of them use expanders. Config-load error added for any
   `expander` block.
2. **Per-finding runtime**: `CheckFinding`, synthetic-finding fallback,
   `--lint --expect-max <N>`, `prd.storySplitMode`, all config-load
   validations from the interaction matrix, and integration tests from the
   Test Coverage section. `RegexCheck` migrated to emit real per-hit
   findings in the same commit (its console `output` stays unchanged; the
   `regex-process-env-ban` snapshot doesn't move).
3. Anything follow-up you actually want after using it once.
