import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-show-first-misuse", (test) => {
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
    .addFixtureFile("src/a.ts", "FAIL\\nFAIL")
    .setArgs("--lint", "--mode", "manual", "--show", "first", "--checks", "test-regex")
    .expectStdout("")
    .expectStderr("--show requires exactly one --checks and exactly one --files\n")
    .expectExitCode(2);
});
