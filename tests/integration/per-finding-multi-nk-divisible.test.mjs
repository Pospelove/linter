import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("per-finding-multi-nk-divisible", (test) => {
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
        "name": "my-check",
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
    ],
    "prd": {
      "storySplitMode": "per-finding",
      "findingsPerStory": 3
    }
  })
    .addFixtureFile("src/a.ts", "FAIL\\nFAIL\\nFAIL\\nFAIL\\nFAIL\\nFAIL")
    .setArgs("--lint", "--mode", "manual", "--output-prd", "prd.json")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: my-check\nAll tracked files: 2 file(s)\nLinting 1 check(s) across 1 file(s)...\nSummary: 1 check(s), 1 failed\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("[FAIL] src/a.ts [my-check]\n  Found FAIL (6 hit(s)):\n  line 1: FAIL\n  line 1: FAIL\n  line 1: FAIL\n  line 1: FAIL\n  line 1: FAIL\n  line 1: FAIL\n")
    .expectExitCode(1)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": [\n    {\n      \"id\": \"US-001\",\n      \"title\": \"Fix my-check in src/a.ts (story 1 of 2; 3 findings)\",\n      \"description\": \"File:  src/a.ts\\nCheck: my-check\\nFindings at PRD generation: 6. Fixed by prior stories: 0.\\nThis story fixes exactly 3 finding(s). STOP after 3 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 3 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks my-check --files src/a.ts --show first\\n  2. Read only the affected range:\\n       Read(src/a.ts, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks my-check --files src/a.ts --expect-max 3\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks my-check --files src/a.ts --expect-max 3\"\n      ],\n      \"priority\": 1,\n      \"passes\": false,\n      \"notes\": \"\"\n    },\n    {\n      \"id\": \"US-002\",\n      \"title\": \"Fix my-check in src/a.ts (story 2 of 2; 3 findings)\",\n      \"description\": \"File:  src/a.ts\\nCheck: my-check\\nFindings at PRD generation: 6. Fixed by prior stories: 3.\\nThis story fixes exactly 3 finding(s). STOP after 3 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 3 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks my-check --files src/a.ts --show first\\n  2. Read only the affected range:\\n       Read(src/a.ts, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks my-check --files src/a.ts --expect-max 0\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks my-check --files src/a.ts --expect-max 0\"\n      ],\n      \"priority\": 2,\n      \"passes\": false,\n      \"notes\": \"\"\n    }\n  ]\n}\n");
});
