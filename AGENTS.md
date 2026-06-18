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
- explicitly declare all class properties, even if assigned in the constructor.
