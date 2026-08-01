import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-expect-max-fail", (test) => {
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
    .addFixtureFile("src/a.ts", "FAIL\nFAIL\nFAIL\nFAIL\nFAIL\n")
    .setArgs("--lint", "--mode", "manual", "--expect-max", "1", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: test-regex\nAll tracked files: 1 file(s)\n5 finding(s) remaining, expected at most 1. Showing first 3:\nFound FAIL\nline 1\nFAIL\nFound FAIL\nline 2\nFAIL\nFound FAIL\nline 3\nFAIL\n(and 2 more — use --show first for the earliest finding with fresh coordinates)\n")
    .expectStderr("")
    .expectExitCode(1);
});
