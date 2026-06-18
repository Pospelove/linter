# linter repo: pro tips for ai coders

## general

- use yarn
- when running without node_modules installed please feel free to run 'yarn'
- ./dist isn't gitignored. this is by design. like in github actions. this is cool because clients can download and use without building the project.
- after each code change please yarn build, this will keep ./dist in sync with source

## typescript

- use `override` keyword for all methods that override base class methods (required by `noImplicitOverride: true`).
- `static override` is also used for static methods overriding base static methods.
- the `as` operator is strictly banned (no-ts-as-operator). Use proper typing, type guards, or `@ts-expect-error` if absolutely necessary.
- avoid " as " in comments and strings to prevent triggering the linter.
- use `interface` and `type` for better type safety.
- `BaseCheck` and `BaseAiProvider` should be used as base classes.
- return types for all methods are encouraged.
- use local variables for private fields after null checks to help TSC with type narrowing.
- avoid `import { ... as ... }` as it may trigger the `no-ts-as-operator` linter. Use `import fs from "fs/promises"` instead of `import { promises as fs } from "fs"`.
- prefix unused parameters with `_` (e.g., `_file`, `_deps`) to avoid `TS6133` errors.
- use `@ts-expect-error` for complex library overloads like `promisify(execFile)` if typing becomes too complex.
- use `NodeJS.ProcessEnv` for environment variables objects.
- when indexing into `Buffer` or `Array` with `noUncheckedIndexedAccess`, always check for `undefined`.
- `spawn` event `close` provides `code: number | null`.
- `RegExpExecArray | null` is the return type of `RegExp.exec()`.
- explicitly type generic collections like `Set<string>` or `Map<string, number>`.
- use non-null assertion `!` sparingly and only when a field is guaranteed to be initialized (e.g., after an `await this.load()` call).
- use `Array<{ ... }>` or `interface[]` for arrays of complex objects.
- `Map<string, string[]>` and other Map/Set collections should always be explicitly typed.
- rephrase "as a string" to "like a string" or "in string format" to avoid the `no-ts-as-operator` linter.
- rephrase "as JSON" to "in JSON format".
- explicitly type getters in base classes to ensure subclasses override them with correct types.
- handle potential `undefined` in `process.argv` and `process.argv[1]`.
- use `(match && match[1]) ? match[1] : default` when accessing RegExp match groups to satisfy strict null checks.
- use `@ts-expect-error` selectively for individual loops when iterating over registries with heterogeneous static method return types.
- use `new Promise<void>((resolve, reject) => ...)` for promises that don't return a value to satisfy `TS2794`.
- use `err instanceof Error ? err.message : String(err)` in catch blocks to safely access error messages from `unknown` types.
- add explicit return types to all exported functions and methods.
