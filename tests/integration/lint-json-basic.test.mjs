import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-json-basic", (test) => {
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
    .addFixtureFile("src/a.ts", "FAIL\n")
    .addFixtureFile("src/b.ts", "PASS\n")
    .setArgs("--lint", "--mode", "manual", "--json")
    .expectStdout("{\"files\":[{\"path\":\"src/a.ts\",\"results\":[{\"check\":\"test-regex\",\"status\":\"fail\",\"findings\":[{\"message\":\"Found FAIL\",\"snippet\":\"FAIL\",\"startLine\":1,\"endLine\":1}],\"output\":\"Found FAIL (1 hit(s)):\\n  line 1: FAIL\"}]},{\"path\":\"src/b.ts\",\"results\":[{\"check\":\"test-regex\",\"status\":\"pass\",\"findings\":[]}]}],\"summary\":{\"pass\":1,\"fail\":1,\"fixed\":0,\"error\":0}}\n")
    .expectStderr("Mode: manual | Source: All tracked files | Checks: test-regex\nAll tracked files: 3 file(s)\n")
    .expectExitCode(1);
});
