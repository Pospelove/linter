import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-expect-max-pass", (test) => {
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
    .setArgs("--lint", "--mode", "manual", "--expect-max", "2", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: test-regex\nAll tracked files: 1 file(s)\nExpected at most 2 finding(s), found 2. If you're an AI agent fixing this step by step, you are OK to proceed.\n")
    .expectStderr("")
    .expectExitCode(0);
});
