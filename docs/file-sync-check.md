# FileSyncCheck (plan)

**Status: decided 2026-10-25, nothing built yet.**

## Motivation

Some facts are written in several files, and that cannot be avoided. A
service name appears in five YAML files of a deployment. A skill's version
appears in the status file of the tests that use it. When an agent changes
one copy, nothing tells it about the others: the repo looks fine until
something breaks at deploy time, or a test keeps a certificate it no longer
deserves.

FileSyncCheck is a guard against the consequences of breaking DRY where
breaking it is unavoidable. A **value** is extracted from several files and
must be **the same everywhere**. When one copy changes, the linter names
every other copy that now disagrees, with file and line, and `--fix` can
update them.

The check compares values, not changes. The weaker rule "file A changed, so
B must change too" is satisfied by any edit of B, even a space, and says
nothing about whether B is now right.

## Model

One check instance describes one kind of synced value:

- **sources**: each is a set of files plus an **extractor** that yields
  `(key, value, line)` triples from a file. One file may yield many.
- One source may be the **leader**: its values are the truth, and the
  others **follow** it. Without a leader, all sources are peers, and every
  key must have one value across all of them.
- For every key, a follower's value must equal the leader's. A follower
  naming a key the leader doesn't have is an error ("refers to `move`, and
  no leader has it"). That is how a rename or a deletion of the leader
  shows up.

### Extractors

| extractor | yields | example |
| --- | --- | --- |
| `regex` | named groups `key` (optional; the source's fixed `key` otherwise) and `value` | `image: registry/(?<value>[^:]+):` |
| `json` | values at a path with `*` wildcards; the key is a wildcard's match or a fixed one | `certified.*.skills.<key>` |
| `yaml` | the same over YAML | `services.*.container_name` |
| `blobHash` | the git blob hash of each file (`git hash-object`); the key is the file's basename without extension | `agent/skills/*.lua` |
| `command` | lines `key<TAB>value<TAB>line` from a command | anything else |

`regex` is the general fallback; `json` and `yaml` exist because a regex
over structured files breaks on formatting.

### Examples

A service renamed in one place:

```json
{
  "export": "FileSyncCheck",
  "options": {
    "name": "service name",
    "leader": { "files": ["deploy/services.yaml"], "yaml": "services.<key>.name" },
    "followers": [
      { "files": ["deploy/k8s/*.yaml"], "yaml": "metadata.labels.app", "key": "api" },
      { "files": [".github/workflows/deploy.yml"], "regex": "SERVICE: (?<value>\\S+)", "key": "api" }
    ]
  }
}
```

Skills and the tests' certificates (fallout4-client
docs/test-reliability.md): a certified test records the blob hash of every
skill it uses, and changing a skill must take the certificate away in the
same PR:

```json
{
  "export": "FileSyncCheck",
  "options": {
    "name": "certificates match the skills they were given for",
    "leader": { "files": ["agent/skills/*.lua"], "blobHash": true },
    "followers": [
      { "files": ["agent/tests/status.json"], "json": "tests.*.certificate.skills.<key>" }
    ],
    "fixCommand": "node agent/tests/status.mjs --lapse"
  }
}
```

## Fix

- **By default, `--fix` rewrites each disagreeing follower occurrence to
  the leader's value**, in place, at the extracted position, and returns
  the changed files (`extraFiles`). This covers the rename case.
- With **`fixCommand`**, the check runs the command instead of rewriting.
  The certificates need this: copying a skill's new hash into a
  certificate would certify the test for code it never ran. The right fix
  is to drop the certificate (the test goes back to `new`).
- With `"fix": false`, the check only reports. Use this where a human must
  decide.
- Peers (no leader) are never rewritten: the check cannot know which copy
  is right. It reports the values and where each one is.

## How it runs in the current core

The core lints files one by one and only the files of the file source
(`DiffBaseSource` in CI, staged files in the hook). That is enough:

- The check applies to every file of every source.
- `lint(file)` reads **all** sources from the working tree (not only the
  file it was called for) and reports the disagreements that involve
  `file`. A changed leader reports every follower that now disagrees, with
  findings pointing at the followers' files and lines. A changed follower
  reports its own disagreeing lines.
- The same disagreement reached from two changed files is reported once
  per file. That is acceptable; findings carry the location.

### Gaps in the core to close

- **Deletions are invisible.** `DiffBaseSource` diffs with
  `--diff-filter=ACMR`, and the staged source does the same, so deleting a
  leader file runs nothing. The fix: file sources also return deleted
  paths, and checks that opt in (`seesDeleted`) are called for them. Only
  FileSyncCheck opts in at first.
- A full read of all sources per changed file is fine for tens of files.
  If a config grows to thousands, cache the extracted sources per run.

## Tests

Integration fixtures, as for the other checks:

- a leader edit with one follower → fail, naming the follower's line;
  `--fix` rewrites the follower;
- a rename and a deleted leader → fail ("no leader has it");
- `fixCommand` runs instead of rewriting;
- peers that disagree → fail, no rewrite;
- every extractor, including `blobHash` matching `git hash-object`.

## Open questions

- Should a follower key missing from the leader be a failure, or only
  with `"strict": true`? A failure is safer, and the default is to start
  strict.
- Should more than one leader source be allowed (several folders of
  truth)? Not needed by either example. Leave it out until a config
  needs it.
