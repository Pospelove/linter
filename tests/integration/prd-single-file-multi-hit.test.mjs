import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("prd-single-file-multi-hit", (test) => {
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
    .addFixtureFile("src/bad.ts", "export const A = process.env.A;\nexport const B = process.env.B;\nexport const C = process.env.C;\n")
    .addFixtureFile("src/good.ts", "export const X = 1;\n")
    .setArgs("--lint", "--mode", "manual", "--output-prd", "prd.json")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: process-env-ban\nAll tracked files: 3 file(s)\nLinting 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 1 passed, 1 failed\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("[FAIL] src/bad.ts [process-env-ban]\n  Do not use process.env directly. (3 hit(s)):\n  line 1: process.env\n  line 2: process.env\n  line 3: process.env\n")
    .expectExitCode(1)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": [\n    {\n      \"id\": \"US-001\",\n      \"title\": \"Fix process-env-ban in src/bad.ts\",\n      \"description\": \"As a developer, I need to fix process-env-ban issue in src/bad.ts so the check passes.\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks process-env-ban --files src/bad.ts\"\n      ],\n      \"priority\": 1,\n      \"passes\": false,\n      \"notes\": \"\"\n    }\n  ]\n}\n");
});
