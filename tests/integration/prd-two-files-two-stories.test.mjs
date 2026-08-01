import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("prd-two-files-two-stories", (test) => {
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
    .addFixtureFile("src/alpha.ts", "export const A = process.env.A;\n")
    .addFixtureFile("src/beta.ts", "export const B = process.env.B;\n")
    .setArgs("--lint", "--mode", "manual", "--output-prd", "prd.json")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: process-env-ban\nAll tracked files: 3 file(s)\nLinting 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 2 failed\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("[FAIL] src/alpha.ts [process-env-ban]\n  Do not use process.env directly. (1 hit(s)):\n  line 1: process.env\n[FAIL] src/beta.ts [process-env-ban]\n  Do not use process.env directly. (1 hit(s)):\n  line 1: process.env\n")
    .expectExitCode(1)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": [\n    {\n      \"id\": \"US-001\",\n      \"title\": \"Fix process-env-ban in src/alpha.ts\",\n      \"description\": \"As a developer, I need to fix process-env-ban issue in src/alpha.ts so the check passes.\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks process-env-ban --files src/alpha.ts\"\n      ],\n      \"priority\": 1,\n      \"passes\": false,\n      \"notes\": \"\"\n    },\n    {\n      \"id\": \"US-002\",\n      \"title\": \"Fix process-env-ban in src/beta.ts\",\n      \"description\": \"As a developer, I need to fix process-env-ban issue in src/beta.ts so the check passes.\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks process-env-ban --files src/beta.ts\"\n      ],\n      \"priority\": 2,\n      \"passes\": false,\n      \"notes\": \"\"\n    }\n  ]\n}\n");
});
