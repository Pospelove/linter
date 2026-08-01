import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-show-first-null", (test) => {
  test.addFixtureFile("linter-config.json", {
    "modes": {
      "manual": {
        "fileSource": {
          "export": "AllFilesSource"
        }
      }
    },
    "checks": [
      {
        "name": "test-regex",
        "export": "RegexCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "extensions": [
            ".ts"
          ],
          "pattern": "FAIL",
          "patternFlags": "g",
          "message": "Found FAIL"
        }
      }
    ]
  })
    .addFixtureFile("src/a.ts", "ok")
    .setArgs("--lint", "--mode", "manual", "--show", "first", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: test-regex\nAll tracked files: 1 file(s)\nnull\n")
    .expectStderr("")
    .expectExitCode(0);
});
