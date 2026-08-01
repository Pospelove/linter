import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("config-findings-per-story-warning", (test) => {
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
          "pattern": "FAIL"
        }
      }
    ],
    "prd": {
      "findingsPerStory": 2
    }
  })
    .addFixtureFile("src/a.ts", "ok")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: my-check\nAll tracked files: 2 file(s)\nLinting 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 1 passed, 1 failed\nCompleted in <TIME>\n")
    .expectStderr("findingsPerStory is ignored when storySplitMode is not per-finding\n[FAIL] linter-config.json [my-check]\n  regex violation (1 hit(s)):\n  line 17: FAIL\n")
    .expectExitCode(1);
});
