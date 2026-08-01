import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-json-misuse-show", (test) => {
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
    .addFixtureFile("src/a.ts", "PASS\n")
    .setArgs("--lint", "--mode", "manual", "--json", "--show", "first", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("")
    .expectStderr("--json rejects --show\n")
    .expectExitCode(2);
});
