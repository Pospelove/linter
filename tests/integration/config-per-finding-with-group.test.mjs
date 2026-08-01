import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("config-per-finding-with-group", (test) => {
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
      "group": "mygroup"
    }
  })
    .addFixtureFile("src/a.ts", "ok")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("")
    .expectStderr("per-finding + prd.group is not allowed\n")
    .expectExitCode(2);
});
