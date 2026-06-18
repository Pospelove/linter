# linter repo: pro tips for ai coders

## general

- use yarn
- when running without node_modules installed please feel free to run 'yarn'
- ./dist isn't gitignored. this is by design. like in github actions. this is cool because clients can download and use without building the project.
- after each code change please yarn build, this will keep ./dist in sync with source
- The `no-ts-as-operator` linter is aggressive and matches " as " (with spaces) in comments and strings. Rephrase to "because it", "like", or "to be" to avoid false positives.
- Catch block errors are typed as `unknown` in strict mode. Use `err instanceof Error ? err.message : String(err)` for safe access.
- Avoid circular dependencies by using inline type imports: `import("./path").Type`.
