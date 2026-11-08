import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("file-sync-peers", (test) => {
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
        "name": "sync",
        "export": "FileSyncCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "name": "version",
          "sources": [
            {
              "files": [
                "a/version.txt"
              ],
              "regex": "^version=(?<value>.+)$",
              "key": "version"
            },
            {
              "files": [
                "b/package.json"
              ],
              "json": "version",
              "key": "version"
            }
          ]
        }
      }
    ]
  })
    .addFixtureFile("a/version.txt", "version=1.2.0\n")
    .addFixtureFile("b/package.json", "{\n  \"version\": \"1.3.0\"\n}\n")
    .setArgs("--fix", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: sync\nAll tracked files: 3 file(s)\nFixing 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 2 failed\nCompleted in <TIME>\n")
    .expectStderr("[FAIL] a/version.txt [sync]\n  version: 1 copy(ies) out of sync:\n  a/version.txt:1: copies of `version` disagree: a/version.txt:1 = \"1.2.0\", b/package.json:2 = \"1.3.0\"\n[FAIL] b/package.json [sync]\n  version: 1 copy(ies) out of sync:\n  b/package.json:2: copies of `version` disagree: a/version.txt:1 = \"1.2.0\", b/package.json:2 = \"1.3.0\"\n")
    .expectExitCode(1)
    .expectGeneratedFile("a/version.txt", "version=1.2.0\n")
    .expectGeneratedFile("b/package.json", "{\n  \"version\": \"1.3.0\"\n}\n");
});
