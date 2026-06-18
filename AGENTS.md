# linter repo: pro tips for ai coders

## general

- use yarn
- when running without node_modules installed please feel free to run 'yarn'
- ./dist isn't gitignored. this is by design. like in github actions. this is cool because clients can download and use without building the project.
- after each code change please yarn build, this will keep ./dist in sync with source
