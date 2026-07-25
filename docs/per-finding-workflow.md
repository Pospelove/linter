# Per-finding workflow

## Motivation

Today a check reports 0 or 1 result per file. A file with 100 regex hits produces
one `[FAIL]` line and — critically — one `--output-prd` user story. That is:

- Coarse for tracking (can't see "37 of 100 fixed").
- Blocks the ralph/PRD flow on large files: a single story covering 100 errors
  can't be handed to a model that doesn't fit the whole file in context.
- Forces authors to split giant files just to shrink the fix unit.

Goal: let a check emit N findings per file, let each finding be its own PRD
story, and give each finding a stable identifier that survives reruns so we can
target it with `--lint`.

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
  
  Rationale for doing it here rather than as a follow-up: keeping the entry
  machinery alive would force `--lint --finding` to reason about entry IDs
  vs file paths, doubling the fingerprint surface for no user benefit. Ripping
  it out first is the smaller change.
- **Checks must be deterministic to be useful per-finding.** Non-deterministic
  checks (AI-based, network-based — `ai-prompt-check`, `firecrawl-check`)
  produce a different set of findings on every run, so their fingerprints
  drift. Policy for phase 1: non-deterministic checks SHOULD NOT emit
  `findings` themselves. If one fails, the runner synthesizes exactly one
  whole-file finding as described below — same granularity as today.
- **File-based entries only.** Every finding refers to a file path relative
  to the repo root. No entry IDs, no slice suffixes.
- **Execution is strictly sequential.** PRD stories are always processed in
  ID order (`US-001` first, `US-002` next, …). No reordering, no interleaving,
  no parallel work across stories. Downstream consumers (ralph and anything
  else) rely on this: several acceptance-criterion mechanics assume that when
  story K is being verified, stories 1..K-1 are already complete. Parallel
  execution is out of scope; if we ever want it we'll design fresh, not
  retrofit.

## Data model

### `CheckFinding`

A check may include `findings` on its `CheckResult`:

```ts
interface CheckFinding {
  message: string;          // one-line human summary
  snippet: string;          // the actual offending text (bytes from the file); "" for whole-file findings
  startLine?: number;       // 1-based; omit for whole-file findings
  endLine?: number;         // 1-based, inclusive; defaults to startLine
  fingerprint?: string;     // filled in by the runner; checks don't set this
}

interface CheckResult {
  status: CheckStatus;
  output?: string;          // existing: freeform text for console display
  extraFiles?: string[];    // existing
  findings?: CheckFinding[]; // NEW
}
```

`snippet` can span multiple lines. It is verbatim file content — no truncation,
no cap. If your check would emit a 10,000-line snippet, that's a check design
problem: rework the check to report a narrower range.

`output` and `findings` coexist. `output` drives the console `[FAIL]` message
(unchanged). `findings` is the machine-readable stream that feeds PRD and
`--lint --finding`.

### Snippet population rule

Empty `snippet` combined with a line range would produce an ambiguous
fingerprint (two findings at lines 42 and 55 with the same empty snippet
would only be told apart by `occ`, which drifts under edits — see below).
So:

- If a finding has `startLine` (and/or `endLine`) but `snippet` is empty or
  missing, the runner reads the file and populates `snippet` from that line
  range **before** deriving the fingerprint. Checks may leave `snippet` blank
  when they trust the runner to fill it.
- If a finding has neither line info nor `snippet`, it is a whole-file
  finding. Empty snippet is only valid in this case, and each (check, file)
  produces at most one such finding.
- If a check emits `snippet` for a whole-file finding (no line info), it is
  respected verbatim.

### Universal invariant: findings.length == 0 iff status == "pass"

The runner enforces this so downstream code never needs a special case:

- If a check returns `status: "fail"` (or `"error"`) with no `findings`, the
  runner synthesizes a single implicit finding:
  ```
  { message: res.output ?? "check failed", snippet: "" }
  ```
  Its fingerprint is derived from `{check, file, snippet: "", occ: 1}` — a
  stable "the whole file failed this check" identifier.
- If a check returns `status: "pass"` with `findings.length > 0`, the runner
  rejects it (implementation bug).

Consequence: legacy checks (`tsc-check`, `encoding-check`, `always-fail`, …)
automatically participate in the per-finding workflow without code changes.
They collapse to one synthetic finding per failed file — matching today's
story-per-file granularity. To emit finer findings (e.g. one per tsc error),
the check must be upgraded to populate `findings` itself.

### Fingerprint

The fingerprint is a debuggable identifier — base64url of a small JSON blob,
not an opaque hash. `base64 -d` on any fingerprint yields readable JSON.

```
normalize(s) = s.trim().replace(/\s+/g, " ")

payload = {
  check:   <checkName>,             // e.g. "process-env-ban"
  file:    <path relative to repo, forward-slash separated>,
  snippet: normalize(finding.snippet),
}

fingerprint = base64url(JSON.stringify(payload))
```

**Content-only, position-independent.** Only `check`, `file`, and normalized
`snippet` participate. No line numbers, no occurrence counter, no
positional information of any kind. A fingerprint identifies *a kind of
problem in a file*, not a specific instance of it.

Consequence: two identical findings in the same file (e.g. two `TODO`
comments) produce the **same** fingerprint. They are still emitted as
separate findings by the check and become separate PRD stories — the story
generator uses instance count and the `--expect-max` mechanism (see PRD
section) to disambiguate. The fingerprint itself does not.

**Path normalization**: the `file` value is always forward-slash separated
and relative to the repo root, on every OS. On Windows we canonicalize with
`path.relative(repo, file).replace(/\\/g, "/")`. Weird path forms — UNC
paths, `\\?\`-prefixed paths, drive-relative paths — are rejected at
fingerprint generation with a clear error rather than silently producing
non-portable fingerprints.

**JSON serialization stability**: the fingerprint is only stable if
`JSON.stringify` produces byte-identical output run-to-run. Node preserves
insertion order for string keys, but we don't rely on that alone. The payload
object is always constructed with a fixed key order (`check`, `file`,
`snippet` — alphabetical) in one helper function. No external dependency (no
`fast-json-stable-stringify` or similar): the payload is tiny and constructed
in exactly one place; a helper with an explicit key order is enough, and one
integration test locks a known-good fingerprint value so any drift trips the
build.

Properties:

- **Stable under edits above the finding.** Lines are not in the payload.
- **Stable under reformatting inside the snippet.** Whitespace is normalized.
- **Stable across OS.** Path is forward-slash normalized.
- **Stable across partial fixes of duplicate findings.** Fixing one of three
  identical `TODO` comments doesn't reshuffle any fingerprint — they all had
  the same fingerprint to begin with. Story-level accounting uses
  `--expect-max` instead of positional identity.
- **Unstable under**: file renames, snippet edits. Acceptable — those are
  material changes to what the finding *is*.
- **Debuggable.** `echo <fp> | base64 -d | jq` tells you what a fingerprint
  refers to in one line.

The runner computes and injects `fingerprint`. Checks only fill `message`,
`snippet` (or leave it blank when line info is present — runner fills it),
and (usually) line range.

## CLI: `--lint --finding <fingerprint>[,<fingerprint>...] [--expect-max <N>]`

Runs the check(s) named in the fingerprint(s) against the file(s) named in the
fingerprint(s), then counts matching finding instances.

`--finding` accepts a single fingerprint or a comma-separated list. When a
list is passed, the runner processes each fingerprint independently and
reports the aggregate result. Fingerprints in one call may reference
different checks and files.

`--expect-max <N>` (default: 0) is the maximum number of instances of the
referenced fingerprint that are allowed to remain in the file for the call
to pass. `N=0` means "must be fully resolved" (the common case for stories
representing a unique problem). `N=2` means "up to 2 instances remaining is
OK" (used by multi-instance ordered stories — see PRD section).

`--expect-max` is only valid when `--finding` names a single fingerprint.
With a comma-separated list, every fingerprint is required to be fully
resolved (`--expect-max 0` implicit); combining `--expect-max` with a list
exits 2.

Exit codes:

| Situation | Exit | Meaning |
|---|---|---|
| Every fingerprint well-formed; instance count ≤ `--expect-max` (or 0) for each | 0 | Story done. |
| Every fingerprint well-formed; at least one fingerprint has instance count > allowed | 1 | Still failing. Prints message + range + snippet for each remaining instance. |
| Any fingerprint malformed (bad base64, bad JSON, missing keys) | 2 | User error. |
| Any fingerprint references a check not in config OR not enabled for current `--mode` | 2 | Config drift. |
| Any fingerprint references a file no longer in repo | 2 | Env drift. |
| `--expect-max` combined with comma-separated `--finding` list | 2 | Invalid usage. |

`--finding` is mutually exclusive with `--files`, `--checks`, and
`--output-prd`. The fingerprints carry the file+check info themselves, and
per-finding verification is not a valid moment to regenerate a full PRD —
combining these would produce a misleading PRD containing only the
re-verified stories. Attempts exit 2 with an explicit message.

### `--fix --finding <fingerprint>`

Reserved but not implemented. Invoking `--fix --finding` exits 2 with:

```
--fix --finding is not implemented. Per-finding auto-fix is not yet
supported. Use --lint --finding to verify a specific finding, or
--fix (without --finding) to apply the check's whole-file fix path.
```

The flag is accepted at parse time (rather than being rejected as unknown) so
the error is explicit and discoverable.

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
    "findingsPerStory": 20,
    "filesPerStory": 1
  }
}
```

`storySplitMode` values:

- `"per-file"` (default): current behavior. One story per (file-chunk × check).
  `filesPerStory` chunks files. `findingsPerStory` is ignored.
- `"per-finding"`: one story per chunk of findings, bounded by `findingsPerStory`
  (max findings per story) and `filesPerStory` (max distinct files per story).
  Stories never cross a file boundary beyond `filesPerStory` files.

### `"per-finding"` chunking

Findings are first grouped by fingerprint. Because the fingerprint is
content-only, all instances of the same problem in a file collapse to one
fingerprint. Each fingerprint then produces one or more stories according to
its instance count:

- **Unique fingerprint (1 instance)**: one story. Its acceptance criterion
  uses `--expect-max 0` (the default), i.e. the fingerprint must be fully
  resolved.
- **Multi-instance fingerprint (M > 1 instances)**: M ordered stories, K =
  1..M. Story K's acceptance criterion uses `--expect-max <M-K>`. When ralph
  processes them sequentially (see Scope — sequential execution is
  guaranteed), each story's criterion passes iff exactly one more instance
  has been fixed since the previous story.

Bundling under `findingsPerStory` and `filesPerStory` **only applies to
unique-fingerprint stories**. Multi-instance stories are always singleton
(exactly one fingerprint per story) so their `--expect-max` semantics stay
unambiguous.

Concretely, unique-fingerprint stories are packed greedily:

- Do not exceed `findingsPerStory` distinct fingerprints per story (default: 1).
- Do not exceed `filesPerStory` distinct files per story (default: 1).

Example: file A has 45 instances of the same TODO snippet plus 3 distinct
other findings; file B has 1 finding; file C has 1 finding. With
`findingsPerStory: 5`, `filesPerStory: 1`:

- A's TODO fingerprint → 45 singleton stories with `--expect-max 44..0`.
- A's 3 unique fingerprints → 1 story (all 3 fit under cap of 5, same file).
- B's 1 unique fingerprint → 1 story.
- C's 1 unique fingerprint → 1 story.
- Total: 48 stories.

**Ordering across the PRD**: multi-instance stories for a given fingerprint
are always contiguous and in K order (US-001, US-002, …, US-00M). Unique
fingerprints appear after multi-instance stories for the same file, packed
into bundled stories. Files are processed in alphabetical order.

Story fields in per-finding mode:

- **title**:
  - Multi-instance story K of M: `Fix <check> in <file> (instance <K> of <M>)`.
  - Singleton unique fingerprint: `Fix <check> in <file>:<startLine>` (line
    from the sole finding).
  - Bundled unique fingerprints (same file): `Fix <check> in <file> (N findings)`.
  - Bundled unique fingerprints (multi-file): `Fix <check> in N files (M findings)`.
- **description**: for each finding covered by the story, includes the
  finding's `message`, its line range at PRD-generation time, and the raw
  `snippet`. For multi-instance stories, the description clarifies that line
  numbers may have shifted between stories: "Fix ONE remaining instance
  matching the snippet. At PRD generation time, M instances existed at lines
  [12, 47, 89]; K-1 have already been fixed by prior stories."
- **acceptanceCriteria**:
  - Multi-instance story K: `[<baseCommand> --lint --finding <fp> --expect-max <M-K>]`.
  - Unique / bundled: `[<baseCommand> --lint --finding <fp1>,<fp2>,...]`
    (implicit `--expect-max 0`).

### Interaction with `prd.group`

Not defined. If a check with `prd.group` also sets `storySplitMode:
"per-finding"`, the runner errors at config load. Cross that bridge when we
need it.

### Templates in `per-finding` mode

`userStoryTitle` and `userStoryDescription` templates work in per-finding mode
with these placeholders (in addition to existing `{file}`, `{files}`,
`{fileCount}`, `{check}`):

- `{findingCount}` — number of findings covered by this story (1 for
  multi-instance singleton stories, N for bundled unique fingerprints).
- `{instanceIndex}` — for multi-instance stories, the K in "K of M" (1-based).
  Empty string for singleton/bundled stories.
- `{instanceCount}` — for multi-instance stories, the M in "K of M". Empty
  string otherwise.
- `{expectMax}` — the value passed to `--expect-max` in the story's
  acceptance criterion.
- `{startLine}`, `{endLine}` — from the first finding in the story.
- `{message}`, `{snippet}`, `{fingerprint}` — from the first finding.
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
  `RegexCheck`*. `RegexCheck` starts populating `findings` internally; its
  `output` string ("N hit(s):\n  line 1: …") is intended to stay unchanged,
  but if the implementation ends up tweaking it, the
  `regex-process-env-ban` snapshot is updated in the same commit and treated
  as intentional. All other checks: unchanged.
- **`--lint` / `--fix` exit codes and semantics unchanged**.
- **All existing check implementations compile and run unchanged** —
  `CheckResult.findings` is optional; the runner synthesizes it when omitted.
- **`linter-config.json` schema is purely additive**: new fields
  (`prd.storySplitMode`, `prd.findingsPerStory`) have safe defaults; unknown
  fields aren't rejected today and aren't now.

### Interaction matrix

Rules for how the new options combine with existing ones:

| Combination | Behavior |
|---|---|
| `storySplitMode` absent or `"per-file"` | Today's behavior, exactly. Findings ignored for PRD purposes; `filesPerStory` chunks files. |
| `storySplitMode: "per-finding"` + check emits real findings | One story per chunk of findings, capped by `findingsPerStory` and `filesPerStory`. |
| `storySplitMode: "per-finding"` + check emits no findings (tsc, encoding, etc.) | Runner injects one synthetic finding per failed file → one story per failed file per check. Same granularity as today. No warning. |
| `storySplitMode: "per-finding"` + `filesPerStory: N` | Both caps apply. See "per-finding chunking" above. |
| `storySplitMode: "per-finding"` + `findingsPerStory: M` | Cap applies to unique fingerprints only; multi-instance fingerprints always produce singleton stories regardless of M. Default M = 1. |
| `storySplitMode: "per-finding"` + `prd.group` | **Hard error at config load.** Not defined; punt until needed. |
| `storySplitMode: "per-finding"` + `userStoryTitle` / `userStoryDescription` | Templates applied with per-finding placeholders (see PRD section). |
| `storySplitMode: "per-finding"` + `additionalAcceptanceCriteria` | Appended to every per-finding story (same as today for per-file). |
| Any check with an `expander` in config (regardless of `storySplitMode`) | **Hard error at config load** — expanders are removed by this feature. See Scope. |
| `storySplitMode` absent (per-file mode) + `findingsPerStory` set | Warn at config load ("findingsPerStory is ignored when storySplitMode is not per-finding"); proceed with today's behavior. |
| `--lint --finding <fp>` when the referenced check is not enabled for `--mode` | Exit 2 (config drift). Even if the check exists in config, if it's not active for the current mode, we can't run it. |
| `--lint --finding` + `--output-prd` | Exit 2 with explicit "combination not supported" message. |
| `--fix --finding` (any form) | Exit 2 with "not implemented" message (see CLI section). |
| Unknown `storySplitMode` value | Hard error at config load with the list of valid values. |

### Downstream PRD consumers

- PRD JSON schema unchanged: `{ project, branchName, description, userStories:
  UserStory[] }` with `UserStory` having `id, title, description,
  acceptanceCriteria, priority, passes, notes`.
- Story IDs remain sequential (`US-001`, `US-002`, …). Fingerprints live
  inside `acceptanceCriteria`, not `id`.
- The only visible change for consumers of a check that opts into per-finding:
  more stories, and acceptance-criteria commands using `--lint --finding <fp>`
  instead of `--lint --checks X --files Y`.

### Runtime shape changes (internal, not user-visible)

- `failedPairs` widens to `Array<{ file, checkName, finding }>` where
  `finding` is always populated (real or synthesized). Not part of any public
  API; touches `linter.ts` only.
- `buildPrd()` receives the wider `failedPairs`. In per-file mode it dedupes
  multiple findings for the same (file, check) back down to one story before
  applying `filesPerStory` — producing today's output exactly.

### Handling duplicate findings (no drift)

Content-only fingerprints mean identical findings share a fingerprint by
design. The story generator turns M identical findings into M ordered
stories with `--expect-max <M-K>` acceptance criteria. Because execution is
strictly sequential (see Scope), each story's criterion passes iff exactly
one more instance has been fixed since the previous story completed. No
positional identity, no drift.

Concrete scenario: file has three `TODO` comments (same normalized snippet)
plus two unique findings. PRD:

- US-001: multi-instance story 1 of 3 for TODO fingerprint, criterion
  `--lint --finding <fp-todo> --expect-max 2`.
- US-002: multi-instance story 2 of 3, `--expect-max 1`.
- US-003: multi-instance story 3 of 3, `--expect-max 0`.
- US-004: unique fingerprint A, `--expect-max 0`.
- US-005: unique fingerprint B, `--expect-max 0`.

Ralph processes in order. On US-001 the model removes any one TODO instance
(they're indistinguishable — pick any). Two remain → `--expect-max 2` passes.
On US-002 the model removes another → one remains → `--expect-max 1` passes.
On US-003 the last one is removed → zero remain → `--expect-max 0` passes.
Ralph never has to guess which TODO belongs to which story; the "which" is
meaningless because the fingerprint identifies the *problem*, not the
*instance*.

If ralph tries to run US-002 before US-001, its criterion `--expect-max 1`
fails (2 instances remain, not ≤1). Sequential order enforces itself.

## Test coverage

Integration tests that must exist by end of phase 1:

- **Backward compat** (locks today's behavior — must pass unchanged):
  - `regex-process-env-ban` — console output. Snapshot may be updated in the
    same commit if RegexCheck's `output` string is intentionally tweaked;
    treat it as intentional change, not regression.
  - `prd-single-file-multi-hit`, `prd-two-files-two-stories`,
    `prd-no-failures` — PRD output for the default (per-file) mode.
- **Fingerprint determinism**: a fixture that produces a known finding and
  asserts the exact expected fingerprint value. Trips the build if
  serialization order, path normalization, or `occ` counting drifts.
- **Per-finding, one-per-story**: `storySplitMode: "per-finding"`, defaults.
  RegexCheck emits multiple findings → PRD has one story per finding, each
  with a `--lint --finding <fp>` acceptance criterion.
- **Per-finding, bundled**: `findingsPerStory: 2`, `filesPerStory: 1`.
  Verify chunking arithmetic on a fixture with e.g. 5 findings across 2 files.
- **Per-finding fallback**: check that never emits real findings (use an
  `AlwaysFailCheck` fixture or similar) with `storySplitMode: "per-finding"`.
  Runner synthesizes one whole-file finding per failed file → one story per
  file.
- **Multi-instance ordered stories**: fixture with a file containing M
  identical findings (M=3). Expected PRD has M stories with `--expect-max
  2,1,0` respectively; `--lint --finding <fp> --expect-max <K>` verifies
  each after simulated partial fixes.
- **Sequential enforcement**: verify that running a multi-instance story's
  criterion out of order (e.g. story 2 before story 1) fails loudly.
- **Config validation errors** (each in its own fixture; assert config-load
  exit code and stderr message):
  - `storySplitMode: "per-finding"` + `prd.group` set.
  - `storySplitMode: "per-finding"` + `expander` set.
  - Unknown `storySplitMode` value.
  - `findingsPerStory` in per-file mode → warn on stderr, still succeeds.
- **`--lint --finding <fp>`**:
  - Exit 0 when instance count ≤ `--expect-max` (default 0 = fully resolved).
  - Exit 1 when instance count > `--expect-max` (assert message/range/snippet
    for remaining instances in output).
  - Exit 2 for malformed base64, well-formed JSON with missing keys, unknown
    check, missing file, and check-not-enabled-for-mode.
- **`--lint --finding <fp1>,<fp2>,<fp3>` aggregation**: mixed resolved/still-
  failing → exit 1; all resolved → exit 0.
- **`--expect-max` misuse**: combined with comma-separated `--finding` list
  → exit 2 with clear message.
- **Banned combinations**: `--lint --finding` + `--output-prd` → exit 2.
  `--fix --finding` → exit 2 with the reserved message.

## Non-goals (for now)

- `--fix --finding <fp>` **implementation**. The flag is recognized and errors
  out explicitly (see CLI section) so users learn the feature is planned but
  not yet built. Actually applying a per-finding fix requires checks to expose
  a targeted-fix path; out of scope until the read/verify loop is proven.
- Standalone `--extract-finding` / `--patch-finding` commands. Snippet-in-
  finding makes these largely redundant.
- Multi-check groups producing per-finding stories.
- Column/byte-offset precision inside a line. Add later if a check needs it.
- ~~Retiring virtual entries~~ — done as part of this feature (see Scope).
- **Per-finding support for non-deterministic checks** (ai-prompt, firecrawl):
  they emit at most one synthesized whole-file finding per failure. If someone
  needs finer granularity for an AI check later, we need a different stability
  contract than content-hash fingerprints.

## Rollout

Commits after this doc lands:

1. **Delete virtual entries / expanders** (see Scope for the full removal
   list). Standalone commit so the diff is unambiguous. Existing tests must
   still pass — none of them use expanders. Config-load error added for any
   `expander` block.
2. **Per-finding runtime**: `CheckFinding`, fingerprint derivation with the
   fixed-key-order helper, synthetic-finding fallback, `--lint --finding
   <fp>[,<fp>...]`, `prd.storySplitMode`, `prd.findingsPerStory`, all
   config-load validations from the interaction matrix, and integration
   tests from the Test Coverage section. `RegexCheck` migrated to emit real
   per-hit findings in the same commit (its console `output` stays
   unchanged; the `regex-process-env-ban` snapshot doesn't move).
3. Anything follow-up you actually want after using it once.

## Addendum: fingerprints completely failed — findings-count in all cases

Fingerprints as a stable per-instance identifier did not work in practice.
Content-only hashing already collapsed duplicate findings to a single
fingerprint (see "Handling duplicate findings" above), forcing us to layer
the `--expect-max <M-K>` counting mechanism on top for multi-instance
fingerprints. In real use, the same counting-based verification also turned
out to be the only reliable signal for *unique* fingerprints: snippet edits,
whitespace drift, and check-side normalization tweaks all invalidate a
fingerprint that was supposed to identify "the same problem," which meant
every non-trivial fix caused fingerprints to churn and downstream stories to
break.

Decision: stop pretending fingerprints identify individual instances. Use
the findings-count semantics we already apply to duplicate fingerprints for
**every** finding, unique or not. A story's acceptance criterion is
"how many instances of this problem remain in this file," never "is this
specific instance gone." Concretely:

- **All per-finding stories become count-based**, not identity-based. A
  singleton unique fingerprint is just the degenerate case M=1 of the
  multi-instance flow: one story with `--expect-max 0`, verified by
  re-running the check and counting matches.
- **Fingerprints are demoted to a grouping key**, not a per-instance
  identifier. They still name a (check, file, normalized-snippet) tuple so
  the runner knows what to count, but no code path treats a fingerprint as
  "this exact occurrence."
- **Bundled stories lose their special path.** Since bundling relied on
  unique fingerprints being individually addressable, and they no longer
  are, bundling collapses to the same M-of-M ordered form used for
  duplicates. `findingsPerStory` still bounds how many *distinct*
  fingerprints share a story, but each story's acceptance criterion is a
  count sum across those fingerprints, not a list of identities.
- **Multi-instance semantics apply uniformly.** For any story covering N
  findings (whether N identical duplicates or N distinct-fingerprint
  bundle), the acceptance criterion is `--expect-max <remaining-after-this-story>`.
  Sequential execution (already guaranteed — see Scope) makes the count
  monotonically decrease, and each story passes iff the expected number of
  findings has been fixed since the previous story.
- **`--lint --finding <fp>` still works** but is understood as "count
  instances matching this fingerprint's snippet in this file," never "find
  this specific instance." The `--expect-max` flag is no longer optional
  scaffolding for duplicates — it is the primary contract for every
  invocation. The default `--expect-max 0` retains its meaning ("all
  matching instances must be gone").

Rationale: the counting mechanic was already load-bearing for the only
case that mattered in practice (repeated snippets). Extending it to cover
unique fingerprints removes an entire class of drift bugs, deletes the
identity-vs-count branching from the story generator and verifier, and
makes the semantics of every story identical: fix N of these, we count
what's left.

### PRD story shape under count-only semantics

Every per-finding story now has the same three-part shape. The agent does
not need to reason about which specific instance a story "owns"; it looks
at the earliest remaining occurrence, fixes it (or fixes X of them for
X-per-story bundles), and re-runs the count.

Story body template:

- **title**: `Fix <check> in <file> (<K> of <M>)` where M is the total
  number of findings sharing this story's fingerprint(s) at PRD-generation
  time, and K is this story's index within that sequence. For X-per-story
  bundles (X > 1), K counts stories, not individual findings.
- **description**:
  1. One-line restatement of the check's `message`.
  2. **"View the earliest remaining occurrence:"** followed by the exact
     command the agent should run to see what to fix, e.g.
     `<baseCommand> --lint --finding <fp> --show first`. This command
     prints `line <N>: <snippet>` for the first still-matching instance in
     the file (or the first instance across the story's fingerprints, in
     bundle order). If nothing matches, it exits 0 with empty output —
     the story is already satisfied.
  3. **"Fix that occurrence"** (or "Fix X of the remaining occurrences"
     for X > 1 bundles). No positional identity is claimed: any matching
     instance will do.
  4. **"Then verify:"** followed by the acceptance-criterion command.
- **acceptanceCriteria**: `[<baseCommand> --lint --finding <fp> --expect-max <M-K*X>]`
  where `X` is this story's findings-per-story (usually 1) and K is the
  story's 1-based index in the sequence. Passes iff at least `K*X`
  instances have been removed since PRD generation.

Because execution is sequential (see Scope), `M - K*X` decreases
monotonically. Story K's criterion becomes satisfiable only after story
K-1 has fixed its share, and it stops being satisfiable if a later story
already fixed too many — which is fine, because the runner processes
stories in order and never revisits a satisfied one.

### `--show first` (new)

A read-only flag on `--lint --finding`. When present, the runner:

- Re-runs the referenced check against the referenced file.
- Sorts the resulting findings by `startLine`, then by `snippet`.
- Prints the first finding as `line <startLine>[-<endLine>]: <snippet>`
  (single-line snippets on one line; multi-line snippets fenced with
  triple backticks so the console output is unambiguous).
- Exits 0 whether or not any finding was found. Exit 2 is reserved for
  the same malformed/unknown/env-drift errors as bare `--lint --finding`.

`--show first` is mutually exclusive with `--expect-max` (viewing is not
verification) and with comma-separated `--finding` lists (the "first"
across multiple fingerprints is ambiguous and the agent can just run the
command per fingerprint). Violations exit 2.

### Uniform story example

File `src/foo.ts` has 3 identical `TODO` snippets plus 1 unique
`console.log` snippet. `findingsPerStory: 1` (default). PRD:

- **US-001**: `Fix no-todo in src/foo.ts (1 of 3)`
  - Description: "Comment left as TODO. View the earliest remaining
    occurrence: `linter --lint --finding <fp-todo> --show first`. Fix
    that occurrence. Then verify:
    `linter --lint --finding <fp-todo> --expect-max 2`."
  - Acceptance: `linter --lint --finding <fp-todo> --expect-max 2`.
- **US-002**: same shape, `--expect-max 1`.
- **US-003**: same shape, `--expect-max 0`.
- **US-004**: `Fix no-console in src/foo.ts (1 of 1)`
  - Description: "console.log left in source. View:
    `linter --lint --finding <fp-console> --show first`. Fix. Verify:
    `linter --lint --finding <fp-console> --expect-max 0`."
  - Acceptance: `linter --lint --finding <fp-console> --expect-max 0`.

Note US-004 uses the exact same three-part shape as US-001..US-003 — the
old "singleton unique fingerprint" specialization is gone. The only
difference from a multi-instance story is that M=1, so K=1 is also
M-K=0 for `--expect-max`.

### Bundled stories (X > 1)

When `findingsPerStory: X` with X > 1, stories still target one
fingerprint each (bundling across distinct fingerprints in one story is
dropped along with the identity-based bundling path). The X value only
increases how many instances each story is responsible for:

- M findings of the same fingerprint → `ceil(M / X)` stories.
- Story K's acceptance: `--expect-max max(M - K*X, 0)`.
- Description: "Fix X of the remaining occurrences" instead of "that
  occurrence." The `--show first` command is unchanged; the agent runs
  it, fixes one, runs it again for the next, until the acceptance
  criterion passes.

The final story in the sequence may be responsible for fewer than X
instances (the remainder). Its `--expect-max 0` acceptance still holds.
