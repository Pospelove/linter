import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-show-all-bogus", (test) => {
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
        "name": "test-regex",
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
    ]
  })
    .addFixtureFile("src/a.ts", "PASS\n")
    .setArgs("--lint", "--mode", "manual", "--show", "bogus", "--checks", "test-regex", "--files", "src/a.ts")
    .expectStdout("")
    .expectStderr("--show only accepts 'first' or 'all'\n")
    .expectExitCode(2);
});
