import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("per-finding-fallback", (test) => {
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
        "name": "always-fail",
        "export": "AlwaysFailCheck",
        "modes": [
          "manual"
        ]
      }
    ],
    "prd": {
      "storySplitMode": "per-finding"
    }
  })
    .addFixtureFile("src/a.ts", "hello")
    .setArgs("--lint", "--mode", "manual", "--output-prd", "prd.json")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: always-fail\nAll tracked files: 2 file(s)\nLinting 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 2 failed\nCompleted in <TIME>\nPRD written to <TMPDIR>/prd.json\n")
    .expectStderr("[FAIL] linter-config.json [always-fail]\n  always-fail: this check always fails\n[FAIL] src/a.ts [always-fail]\n  always-fail: this check always fails\n")
    .expectExitCode(1)
    .expectGeneratedFile("prd.json", "{\n  \"project\": \"Project\",\n  \"branchName\": \"ralph/lint-fixes\",\n  \"description\": \"Fix outstanding lint issues\",\n  \"userStories\": [\n    {\n      \"id\": \"US-001\",\n      \"title\": \"Fix always-fail in linter-config.json\",\n      \"description\": \"File:  linter-config.json\\nCheck: always-fail\\nFindings at PRD generation: 1. Fixed by prior stories: 0.\\nThis story fixes exactly 1 finding(s). STOP after 1 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 1 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks always-fail --files linter-config.json --show first\\n  2. Read only the affected range:\\n       Read(linter-config.json, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks always-fail --files linter-config.json --expect-max 0\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks always-fail --files linter-config.json --expect-max 0\"\n      ],\n      \"priority\": 1,\n      \"passes\": false,\n      \"notes\": \"\"\n    },\n    {\n      \"id\": \"US-002\",\n      \"title\": \"Fix always-fail in src/a.ts\",\n      \"description\": \"File:  src/a.ts\\nCheck: always-fail\\nFindings at PRD generation: 1. Fixed by prior stories: 0.\\nThis story fixes exactly 1 finding(s). STOP after 1 iterations, even\\nif more remain — later stories cover them. Any remaining finding may be\\naddressed; findings are interchangeable.\\n\\nRepeat exactly 1 times:\\n  1. Locate the earliest remaining finding:\\n       node <LINTER> --lint --checks always-fail --files src/a.ts --show first\\n  2. Read only the affected range:\\n       Read(src/a.ts, offset: startLine - 2, limit: (endLine - startLine) + 5)\\n  3. Apply the fix with Edit(old_string=snippet, new_string=<your fix>).\\n\\nTool names above (Read, Edit) are Claude Code's; if you're a different\\nagent, use your equivalents (e.g. read_file / str_replace, view / create,\\nfs.readFile / applyPatch — whatever your host exposes). The semantics are\\nwhat matter: read a small range around the finding, then replace the\\nreturned snippet exactly.\\n\\nThen verify:\\n  node <LINTER> --lint --checks always-fail --files src/a.ts --expect-max 0\",\n      \"acceptanceCriteria\": [\n        \"node <LINTER> --lint --checks always-fail --files src/a.ts --expect-max 0\"\n      ],\n      \"priority\": 2,\n      \"passes\": false,\n      \"notes\": \"\"\n    }\n  ]\n}\n");
});
