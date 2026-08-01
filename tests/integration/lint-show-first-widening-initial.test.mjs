import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-show-first-widening-initial", (test) => {
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
    .addFixtureFile("src/a.ts", "L1\\nL2\\nFAIL\\nL4\\nL5")
    .setArgs("--lint", "--mode", "manual", "--show", "first", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: test-regex\nAll tracked files: 1 file(s)\n{\"startLine\":1,\"endLine\":1,\"snippet\":\"L1\\\\nL2\\\\nFAIL\\\\nL4\\\\nL5\",\"message\":\"Found FAIL\"}\n")
    .expectStderr("")
    .expectExitCode(0);
});
