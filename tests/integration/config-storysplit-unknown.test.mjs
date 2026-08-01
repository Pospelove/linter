import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("config-storysplit-unknown", (test) => {
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
      "storySplitMode": "unknown"
    }
  })
    .addFixtureFile("src/a.ts", "ok")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("")
    .expectStderr("Invalid prd.storySplitMode: unknown. Valid values are: per-file, per-finding\n")
    .expectExitCode(2);
});
