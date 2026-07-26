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

## CLI

Two new modes on `--lint`, both scoped to a single (check, file) pair:
`--expect-max <N>` for count-based verification, and `--show first` to
locate the earliest current finding without reading the whole file. They
compose independently — one tells the agent "am I done?", the other tells
it "where's the next one?" Not combinable in a single call; run twice.

### `--lint --expect-max <N>`

Combined with `--checks <check>` and `--files <file>` (each naming exactly
one), passes iff the check produces at most `N` findings on the file.

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

### `--lint --show <mode>`

Prints information about the current findings, so a fix agent can locate
one without reading the whole file. Query-time only; no side effects, no
writes. Only one mode is defined today: `first`. Any other value exits 2
(reserved).

Combined with `--checks <check>` and `--files <file>` (each naming exactly
one). `--show first` output is a single line of JSON:

```json
{"startLine": 4210, "endLine": 4213, "snippet": "...", "message": "..."}
```

Fields:

- `startLine`, `endLine`, `message`: from the finding, unmodified.
- `snippet`: widened to be unique in the file — see algorithm below.
- `unique`: **optional**. Emitted as `false` only in the rare case that
  widening hit its cap without producing a unique snippet. Omitted (i.e.
  implicit `true`) in the common case.

If the file has zero findings, prints `null` and exits 0. Presence/absence
is data, not failure — `--show` never exits 1.

**Ordering**: findings sorted by ascending `startLine`; ties broken by the
check's original emit order. Deterministic across runs (given deterministic
checks).

**Snippet widening algorithm**: expand `snippet` until it occurs exactly
once in the file, so a follow-up `Edit(old_string=snippet, ...)` matches
unambiguously.

1. Start with 2 lines of surrounding context above and 2 below the finding
   range, clipped at file boundaries.
2. If the resulting substring occurs exactly once in the file, emit it.
3. Otherwise, extend by 1 line above and 1 line below and retry. Cap: at
   most 20 added lines above and 20 below (the underlying finding range is
   always included in full).
4. If uniqueness is still not reached at the cap, emit the maximally
   widened snippet and add `"unique": false` to the JSON response. The
   agent's fallback: use `startLine` to `Read` a wider range around the
   finding and construct a longer `old_string` from that read.

Widening is scoped to `--show` output — nothing else touches the on-disk
snippet, the finding count, or `--expect-max` behavior. Performance: worst
case scans the file once per widening step; on multi-hundred-MB inputs
this may take a few seconds per call. Acceptable — `--show first` is a
per-story query, not a hot path.

Exit codes:

| Situation | Exit | Meaning |
|---|---|---|
| Prints JSON object or `null` | 0 | Query answered. |
| `--show` combined with `--fix` | 2 | Invalid usage. |
| `--show` combined with `--expect-max` in one call | 2 | Invalid usage — each does one thing; run twice. |
| `--show` combined with `--output-prd` | 2 | Invalid usage. |
| `--show` with zero or multiple `--checks` or `--files` | 2 | Invalid usage. |
| `--show` with any value other than `first` | 2 | Reserved for future modes. |
| `--show` referencing an unknown check, or a check not enabled for the current `--mode` | 2 | Config drift. |
| `--show` referencing a missing file | 2 | Env drift. |

### `--fix` interactions

Neither `--expect-max` nor `--show` is defined for `--fix`. Fixing a
specific finding by identity is impossible under this model (findings have
no identity). `--fix` continues to apply the check's whole-file fix path
as today. Combining `--fix` with either flag exits 2 with an explicit
message.

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
    "findingsPerStory": 3,
    "filesPerStory": 1
  }
}
```

`storySplitMode` values:

- `"per-file"` (default): current behavior. One story per (file-chunk × check).
  `filesPerStory` chunks files. Per-finding count is ignored.
- `"per-finding"`: for each (check, file) that produces M findings, emit
  `ceil(M / N)` ordered stories where `N = prd.findingsPerStory` (default 1;
  must be a positive integer). Each story is budgeted for N findings; the
  last one may be smaller if M is not divisible by N. `filesPerStory` MUST
  be 1 in this mode (default); other values are a config-load error.

### `"per-finding"` chunking

Let `N = prd.findingsPerStory` (default 1) and `S = ceil(M / N)`. For each
(check, file) pair with M ≥ 1 findings, emit S ordered stories K = 1..S:

- Story K's budget is `Nₖ = min(N, M - (K-1) * N)` findings — every story
  is responsible for N, except the last which may be responsible for fewer
  when M is not divisible by N.
- Story K's acceptance criterion:
  `<baseCommand> --lint --checks <check> --files <file> --expect-max <max(0, M - K*N)>`
- Story K passes iff at most `max(0, M - K*N)` findings remain for the check.

Because execution is sequential, story K only runs after stories 1..K-1
passed — i.e. after at least `(K-1) * N` findings were already fixed.
Story K then requires at least Nₖ more to be resolved. Which specific ones
doesn't matter: findings are fungible.

Enforcement is a soft lower bound. `--expect-max` verifies the count
dropped by at least the expected amount, but nothing prevents an agent
from over-fixing on story K (dropping the count further than needed).
Over-fixing doesn't fail the story; later stories just find less work
than budgeted and pass trivially. The workflow script in each story
description tells the agent explicitly to stop after Nₖ iterations, which
is enough in practice — treat rogue over-fixing as an agent-behavior
problem, not a linter guarantee.

Ordering: for a given (check, file), the M stories are contiguous and in K
order (US-001, US-002, …, US-00M). Files are processed in alphabetical
order; within a file, checks are processed in config order. Multi-file
runs concatenate per-(check, file) groups.

Story fields in per-finding mode:

- **title**:
  - M = 1: `Fix <check> in <file>:<startLine>` (line from the sole finding
    when present; falls back to just the file).
  - S = 1, M > 1: `Fix <check> in <file> (M findings)`.
  - S > 1: `Fix <check> in <file> (story K of S; Nₖ findings)`.
- **description**: an explicit fix-workflow script. Line numbers are NOT
  baked into the story text — they go stale as soon as a prior story
  edits the file. The agent queries them fresh at fix time via
  `--show first`. Default body:
  ```
  File:  <file>
  Check: <check>
  Findings at PRD generation: M. Fixed by prior stories: (K-1) * N.
  This story fixes exactly Nₖ finding(s). STOP after Nₖ iterations, even
  if more remain — later stories cover them. Any remaining finding may be
  addressed; findings are interchangeable.

  Repeat exactly Nₖ times:
    1. Locate the earliest remaining finding:
         <baseCommand> --lint --checks <check> --files <file> --show first
       Output: JSON {startLine, endLine, snippet, message}, or `null` if none.
    2. Read only the affected range:
         Read(<file>, offset: startLine - 2, limit: (endLine - startLine) + 5)
    3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).
       The snippet returned by --show includes surrounding context, so it
       is unique inside the file — Edit will not ambiguously match.

  Then verify this story is done:
    <baseCommand> --lint --checks <check> --files <file> --expect-max <max(0, M - K*N)>
  ```
  Rationale: `--show first` returns fresh coordinates every time, so a
  finding in the middle of a 1 GB file can be located and edited without
  reading the whole file. The explicit `Nₖ` iteration count is the sole
  mechanism keeping the agent within its per-story budget — enforcement
  is soft (see "per-finding chunking" above). For single-story cases
  (S = 1) the same script is emitted — one code path.
- **acceptanceCriteria**:
  `[<baseCommand> --lint --checks <check> --files <file> --expect-max <max(0, M - K*N)>]`.

### Interaction with `prd.group`

Not defined. If a check with `prd.group` also sets `storySplitMode:
"per-finding"`, the runner errors at config load. Cross that bridge when
we need it.

### Templates in `per-finding` mode

`userStoryTitle` and `userStoryDescription` templates work in per-finding
mode with these placeholders (in addition to existing `{file}`, `{files}`,
`{fileCount}`, `{check}`):

- `{findingCount}` — M, total findings for the (check, file) at PRD generation.
- `{storyCount}` — S = `ceil(M / N)`, total stories for this (check, file).
- `{storyIndex}` — K in "story K of S" (1-based).
- `{storyBudget}` — Nₖ, findings this story is responsible for (may be
  less than the configured N for the last story when M is not divisible
  by N).
- `{expectMax}` — value passed to `--expect-max` in the acceptance criterion
  (`max(0, M - K*N)`).
- `{startLine}`, `{endLine}` — from the first finding in the file **at PRD
  generation time**. Snapshots only — will drift once prior stories edit
  the file. Use `--show first` at fix time for fresh coordinates. Included
  as placeholders for template authors who want a rough hint in the title;
  the default description does not use them.
- `{message}`, `{snippet}` — from the first finding at PRD generation.
- `{findings}` — all findings rendered as `line N: <snippet>` joined by newlines.
- `{workflow}` — the full default workflow-script body (Steps 1–4 above).
  A custom `userStoryDescription` template can embed it verbatim so
  overriding the description doesn't lose the fix-time query loop.

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
- **`linter-config.json` schema is purely additive**: new fields
  (`prd.storySplitMode`, `prd.findingsPerStory`) have safe defaults;
  unknown fields aren't rejected today and aren't now.

### Interaction matrix

| Combination | Behavior |
|---|---|
| `storySplitMode` absent or `"per-file"` | Today's behavior, exactly. Per-finding count ignored for PRD purposes; `filesPerStory` chunks files. |
| `storySplitMode: "per-finding"` + check emits real findings | For each (check, file) with M findings, emit `ceil(M/N)` ordered stories (N = `findingsPerStory`, default 1). Story K's `--expect-max` = `max(0, M - K*N)`. |
| `storySplitMode: "per-finding"` + check emits no findings (tsc, encoding, etc.) | Runner injects one synthetic finding per failed file → one story per failed file per check. Same granularity as today. No warning. |
| `storySplitMode: "per-finding"` + `findingsPerStory: N` (positive integer) | Chunk each (check, file)'s findings into groups of N, last group may be smaller. Description includes explicit "fix Nₖ, then STOP" guidance. |
| `storySplitMode: "per-finding"` + `findingsPerStory <= 0` or non-integer | **Hard error at config load.** |
| `findingsPerStory` set with `storySplitMode: "per-file"` (or absent) | Warn at config load ("findingsPerStory is ignored when storySplitMode is not per-finding"); proceed with today's behavior. |
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
| `--lint --show first` in per-file mode | Works. Not tied to per-finding stories — anyone can query the earliest finding for a (check, file). |
| `--lint --show first` on a file with zero findings | Prints `null`, exit 0. |
| `--show` combined with `--fix`, `--expect-max`, or `--output-prd` | Exit 2. |
| `--show` with zero or multiple `--checks` or `--files` | Exit 2. |
| `--show` with any value other than `first` | Exit 2 (reserved for future modes). |
| `--show` referencing an unknown check, check-not-enabled-for-mode, or missing file | Exit 2. |

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

Same M = 5 with `findingsPerStory: 2` produces `ceil(5/2) = 3` stories:

- US-001: budget 2, `--expect-max 3`. Description: "fix exactly 2, STOP".
- US-002: budget 2, `--expect-max 1`. Description: "fix exactly 2, STOP".
- US-003: budget 1 (remainder), `--expect-max 0`. Description: "fix exactly 1, STOP".

If the agent respects the STOP guidance, each story does its budgeted
work. If the agent over-fixes on US-001 (removes 3 instead of 2), count
drops to 2 → `--expect-max 3` still passes; US-002 then sees 2 remaining
and only needs to remove 1 for `--expect-max 1` to pass; US-003 sees 1
remaining and removes it. Same total work, uneven distribution. No
correctness issue.

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
- **Per-finding, multi-finding file (N=1)**: file with three findings and
  default `findingsPerStory: 1` → PRD has three stories with acceptance
  criteria `--expect-max 2, 1, 0`. Descriptions instruct "fix 1, STOP".
- **Per-finding with `findingsPerStory: N > 1`, remainder**: file with 7
  findings and `findingsPerStory: 3` → PRD has 3 stories with
  `--expect-max 4, 1, 0`. Story 3's description indicates budget 1
  (remainder), not 3.
- **Per-finding with `findingsPerStory: N > 1`, divisible**: file with 6
  findings and `findingsPerStory: 3` → PRD has 2 stories, each budget 3,
  with `--expect-max 3, 0`.
- **Per-finding fallback**: check that never emits real findings (use an
  `AlwaysFailCheck` fixture) with `storySplitMode: "per-finding"`. Runner
  synthesizes one whole-file finding per failed file → one story per file
  with `--expect-max 0`. Unaffected by `findingsPerStory`.
- **Sequential enforcement**: running a multi-finding story's criterion out
  of order (story 3 before story 1) fails loudly (exit 1) with the expected
  "N > expect-max" style message.
- **Config validation errors** (each in its own fixture; assert config-load
  exit code and stderr message):
  - `storySplitMode: "per-finding"` + `prd.group` set.
  - `storySplitMode: "per-finding"` + `filesPerStory: 2`.
  - `storySplitMode: "per-finding"` + `findingsPerStory: 0` (or negative,
    or non-integer).
  - `storySplitMode: "per-finding"` + `expander` set.
  - Unknown `storySplitMode` value.
- **Config validation warnings** (assert stderr warning, exit 0, behavior
  unchanged):
  - `findingsPerStory` set with `storySplitMode: "per-file"` (or absent).
- **`--lint --expect-max N`**:
  - Exit 0 when findings.length ≤ N.
  - Exit 1 when findings.length > N (assert message/range/snippet for
    remaining findings in output).
  - Exit 2 for: `--fix` combination, zero or multiple `--checks`, zero or
    multiple `--files`, negative N, non-integer N, unknown check,
    check-not-enabled-for-mode, missing file, combination with `--output-prd`.
- **`--lint --show first`**:
  - Prints correct JSON for a file with multiple findings — first by
    ascending `startLine`, ties by emit order.
  - Prints `null` and exits 0 for a file with no findings.
  - Widening starts at 2 lines above/below and produces a unique `snippet`
    in the common case; JSON omits the `unique` field.
  - Widening extends up to the 20+20 line cap when needed for uniqueness
    (fixture: file where the initial 2+2 window is not unique, a wider
    one is; assert the emitted snippet is exactly the smallest unique
    widening).
  - Widening cap reached without uniqueness (fixture: file with a
    deliberately repetitive block larger than the cap): assert the JSON
    contains `"unique": false` and emits the maximally widened snippet.
  - Ordering deterministic across two runs on identical input.
  - Widening does not affect `--expect-max` count on the same input
    (independence test).
  - Exit 2 for: `--fix` combination, `--expect-max` combination in one
    call, `--output-prd` combination, zero or multiple `--checks`, zero
    or multiple `--files`, `--show <bogus>`, unknown check,
    check-not-enabled-for-mode, missing file.

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
