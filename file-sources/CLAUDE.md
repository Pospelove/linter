# File Sources Module

## Conventions
- All file sources must extend `BaseFileSource`.
- Use `override` for `name`, `resolve`, and `static getHelp`.
- The `resolve` method should return `Promise<string[]>`.
- Handle file existence checks using `fs.promises.access` and filter out missing files.
- Use `existing.filter((filePath): filePath is string => filePath !== null)` to properly narrow types after a `Promise.all` that returns `null` for missing files.

## Gotchas
- `simple-git` methods like `git.raw` and `git.diff` return strings that need splitting and filtering.
- String indexing with `p[i]` can return `undefined` under `noUncheckedIndexedAccess`; use `p.charAt(i)` for safety in loops.
- `process.env` properties should be accessed via bracket notation (e.g., `process.env['GITHUB_BASE_REF']`) to satisfy strict TSC rules.
