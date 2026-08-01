import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("lint-json-misuse-fix", (test) => {
  test.addFixtureFile("linter-config.json", {
    "modes": {
      "manual": {
        "fileSource": {
          "export": "AllFilesSource"
        }
      }
    },
    "checks": []
  })
    .setArgs("--lint", "--fix", "--json", "--mode", "manual")
    .expectStdout("")
    .expectStderr("--json requires --lint and rejects --fix\n")
    .expectExitCode(2);
});
