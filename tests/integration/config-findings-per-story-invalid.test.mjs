import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("config-findings-per-story-invalid", (test) => {
  test.addFixtureFile("linter-config.json", {
      modes: {
        manual: { fileSource: { export: "AllFilesSource" } },
      },
      checks: [
        {
          name: "my-check",
          export: "RegexCheck",
          modes: ["manual"],
          options: { pattern: "FAIL" },
        },
      ],
      prd: {
        storySplitMode: "per-finding",
        findingsPerStory: -1,
      },
    })
      .addFixtureFile("src/a.ts", "ok")
      .setArgs("--lint", "--mode", "manual")
      .expectStdout("")
      .expectStderr("per-finding + findingsPerStory <= 0 or non-integer is not allowed\n")
      .expectExitCode(2);
  });
