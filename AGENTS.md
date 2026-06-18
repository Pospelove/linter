# linter repo: pro tips for ai coders

## general

- use yarn
- when running without node_modules installed please feel free to run 'yarn'
- ./dist isn't gitignored. this is by design. like in github actions. this is cool because clients can download and use without building the project.
- after each code change please yarn build, this will keep ./dist in sync with source
- The `no-ts-as-operator` linter is aggressive and matches " as " (with spaces) in comments and strings. Rephrase to "because it", "like", or "to be" to avoid false positives.
- Use `@ts-expect-error` sparingly when the `as` operator is banned and idiomatic typing is too complex.
- When parsing `Record<string, unknown>` options in constructors, use `String()`, `Number()`, or `!!` for safe conversion, and type guards for arrays/objects.
- Access `Record<string, unknown>` properties using bracket notation (e.g., `options["key"]`).
- In catch blocks, errors are `unknown`. Use `if (err instanceof Error)` or property checks like `if (err && typeof err === "object" && "message" in err)` to safely access diagnostic info.
- When `as` is banned, use explicit type declarations for literals (e.g., `const res: Type = { ... }`) to ensure they match specific union types or interfaces.
