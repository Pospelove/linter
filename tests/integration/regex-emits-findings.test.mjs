import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("regex-emits-findings", (test) => {
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
        "name": "regex-emits",
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
      "storySplitMode": "per-finding"
    }
  })
    .addFixtureFile("src/a.ts", "FAIL")
    .setArgs("--lint", "--mode", "manual", "--output-prd", "prd.json")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: regex-emits\nAll tracked files: 2 file(s)\nLinting 1 check(s) across 1 file(s)...\nSummary: 1 check(s), 1 failed\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("[FAIL] src/a.ts [regex-emits]\n  Found FAIL (1 hit(s)):\n  line 1: FAIL\n")
    .expectExitCode(1)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": [\n    {\n      \"id\": \"US-001\",\n      \"title\": \"Fix regex-emits in src/a.ts:1\",\n      \"description\": \"File:  src/a.ts\\nCheck: regex-emits\\nFindings at PRD generation: 1. Fixed by prior stories: 0.\\nThis story fixes exactly 1 finding(s). STOP after 1 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 1 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks regex-emits --files src/a.ts --show first\\n  2. Read only the affected range:\\n       Read(src/a.ts, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks regex-emits --files src/a.ts --expect-max 0\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks regex-emits --files src/a.ts --expect-max 0\"\n      ],\n      \"priority\": 1,\n      \"passes\": false,\n      \"notes\": \"\"\n    }\n  ]\n}\n");
});
