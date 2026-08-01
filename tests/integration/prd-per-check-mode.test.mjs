import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("prd-per-check-mode", (test) => {
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
        "name": "fail-per-finding",
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
        },
        "prd": {
          "storySplitMode": "per-finding",
          "findingsPerStory": 1
        }
      },
      {
        "name": "bad-per-file",
        "export": "RegexCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "extensions": [
            ".ts"
          ],
          "pattern": "BAD",
          "patternFlags": "g",
          "message": "Found BAD"
        }
      }
    ]
  })
    .addFixtureFile("src/a.ts", "FAIL\nBAD\nFAIL\nBAD\n")
    .setArgs("--lint", "--mode", "manual", "--output-prd")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: fail-per-finding, bad-per-file\nAll tracked files: 2 file(s)\nLinting 2 check(s) across 1 file(s)...\nSummary: 2 check(s), 2 failed\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("[FAIL] src/a.ts [fail-per-finding]\n  Found FAIL (2 hit(s)):\n  line 1: FAIL\n  line 3: FAIL\n[FAIL] src/a.ts [bad-per-file]\n  Found BAD (2 hit(s)):\n  line 2: BAD\n  line 4: BAD\n")
    .expectExitCode(1)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": [\n    {\n      \"id\": \"US-001\",\n      \"title\": \"Fix fail-per-finding in src/a.ts (story 1 of 2; 1 findings)\",\n      \"description\": \"File:  src/a.ts\\nCheck: fail-per-finding\\nFindings at PRD generation: 2. Fixed by prior stories: 0.\\nThis story fixes exactly 1 finding(s). STOP after 1 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 1 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks fail-per-finding --files src/a.ts --show first\\n  2. Read only the affected range:\\n       Read(src/a.ts, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks fail-per-finding --files src/a.ts --expect-max 1\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks fail-per-finding --files src/a.ts --expect-max 1\"\n      ],\n      \"priority\": 1,\n      \"passes\": false,\n      \"notes\": \"\"\n    },\n    {\n      \"id\": \"US-002\",\n      \"title\": \"Fix fail-per-finding in src/a.ts (story 2 of 2; 1 findings)\",\n      \"description\": \"File:  src/a.ts\\nCheck: fail-per-finding\\nFindings at PRD generation: 2. Fixed by prior stories: 1.\\nThis story fixes exactly 1 finding(s). STOP after 1 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 1 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks fail-per-finding --files src/a.ts --show first\\n  2. Read only the affected range:\\n       Read(src/a.ts, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks fail-per-finding --files src/a.ts --expect-max 0\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks fail-per-finding --files src/a.ts --expect-max 0\"\n      ],\n      \"priority\": 2,\n      \"passes\": false,\n      \"notes\": \"\"\n    },\n    {\n      \"id\": \"US-003\",\n      \"title\": \"Fix bad-per-file in src/a.ts\",\n      \"description\": \"As a developer, I need to fix bad-per-file issue in src/a.ts so the check passes.\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks bad-per-file --files src/a.ts\"\n      ],\n      \"priority\": 3,\n      \"passes\": false,\n      \"notes\": \"\"\n    }\n  ]\n}\n");
});
