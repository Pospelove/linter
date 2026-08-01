import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("config-per-finding-with-files-per-story", (test) => {
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
      "storySplitMode": "per-finding",
      "filesPerStory": 2
    }
  })
    .addFixtureFile("src/a.ts", "ok")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("")
    .expectStderr("per-finding + filesPerStory != 1 is not allowed\n")
    .expectExitCode(2);
});
