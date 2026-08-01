import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("prd-no-failures", (test) => {
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
        "name": "process-env-ban",
        "export": "RegexCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "extensions": [
            ".ts"
          ],
          "pattern": "\\bprocess\\.env\\b",
          "patternFlags": "gu",
          "message": "Do not use process.env directly.",
          "skipLinePatterns": [
            "^\\s*//",
            "^\\s*\\*"
          ]
        }
      }
    ]
  })
    .addFixtureFile("src/good.ts", "export const X = 1;\n")
    .setArgs("--lint", "--mode", "manual", "--output-prd", "prd.json")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: process-env-ban\nAll tracked files: 2 file(s)\nLinting 1 check(s) across 1 file(s)...\nSummary: 1 check(s), 1 passed\nLinting completed.\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("")
    .expectExitCode(0)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": []\n}\n");
});
