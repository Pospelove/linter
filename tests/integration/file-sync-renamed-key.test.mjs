import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("file-sync-renamed-key", (test) => {
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
          "name": "certificates",
          "leader": {
            "files": [
              "skills/*.lua"
            ],
            "blobHash": true
          },
          "followers": [
            {
              "files": [
                "tests/status.json"
              ],
              "json": "tests.*.certificate.skills.<key>"
            }
          ]
        }
      }
    ]
  })
    .addFixtureFile("skills/walk.lua", "return { move = 1 }\n")
    .addFixtureFile("tests/status.json", "{\n  \"tests\": {\n    \"t1\": {\n      \"certificate\": {\n        \"skills\": {\n          \"move\": \"ac2f16c6915a548b041c3bfda8befa7dea01d3f3\"\n        }\n      }\n    }\n  }\n}\n")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: sync\nAll tracked files: 3 file(s)\nLinting 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 2 failed\nCompleted in <TIME>\n")
    .expectStderr("[FAIL] skills/walk.lua [sync]\n  certificates: 1 copy(ies) out of sync:\n  tests/status.json:6: refers to `move`, and no leader has it\n[FAIL] tests/status.json [sync]\n  certificates: 1 copy(ies) out of sync:\n  tests/status.json:6: refers to `move`, and no leader has it\n")
    .expectExitCode(1);
});
