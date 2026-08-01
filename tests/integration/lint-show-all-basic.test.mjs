import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-show-all-basic", (test) => {
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
    .addFixtureFile("src/a.ts", "FAIL\nPASS\nFAIL\n")
    .setArgs("--lint", "--mode", "manual", "--show", "all", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: test-regex\nAll tracked files: 1 file(s)\n[{\"startLine\":1,\"endLine\":1,\"snippet\":\"FAIL\\nPASS\\nFAIL\",\"message\":\"Found FAIL\"},{\"startLine\":3,\"endLine\":3,\"snippet\":\"FAIL\\nPASS\\nFAIL\\n\",\"message\":\"Found FAIL\"}]\n")
    .expectStderr("")
    .expectExitCode(0);
});
