import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-expect-max-misuse", (test) => {
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
    .addFixtureFile("src/a.ts", "FAIL")
    .setArgs("--lint", "--mode", "manual", "--expect-max", "1", "--fix", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("")
    .expectStderr("--expect-max requires --lint and rejects --fix\n")
    .expectExitCode(2);
});
