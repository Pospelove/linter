import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("regex-process-env-ban", (test) => {
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
        "name": "process-env-ban",
        "export": "RegexCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "extensions": [
            ".ts"
          ],
          "pattern": "\\bprocess\\.env\\b",
          "patternFlags": "gu",
          "message": "Do not use process.env directly. Use env from utils/env.ts instead.",
          "skipLinePatterns": [
            "^\\s*//",
            "^\\s*\\*"
          ]
        }
      }
    ]
  })
    .addFixtureFile("src/bad.ts", "export const FOO = process.env.FOO;\n")
    .addFixtureFile("src/env.ts", "export const env = { FOO: \"stub\" };\n")
    .addFixtureFile("src/good.ts", "import { env } from \"./env.js\";\nexport const FOO = env.FOO;\n")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: process-env-ban\nAll tracked files: 4 file(s)\nLinting 3 check(s) across 3 file(s)...\nSummary: 3 check(s), 2 passed, 1 failed\nCompleted in <TIME>\n")
    .expectStderr("[FAIL] src/bad.ts [process-env-ban]\n  Do not use process.env directly. Use env from utils/env.ts instead. (1 hit(s)):\n  line 1: process.env\n")
    .expectExitCode(1);
});
