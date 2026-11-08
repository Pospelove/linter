import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("file-sync-fix-command", (test) => {
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
          ],
          "fixCommand": "node lapse.mjs"
        }
      }
    ]
  })
    .addFixtureFile("skills/move.lua", "return { move = 2 }\n")
    .addFixtureFile("lapse.mjs", "import fs from 'node:fs';\nconst f = 'tests/status.json';\nconst j = JSON.parse(fs.readFileSync(f, 'utf-8'));\nfor (const t of Object.values(j.tests)) { delete t.certificate; t.status = 'new'; }\nfs.writeFileSync(f, JSON.stringify(j, null, 2) + '\\n');\n")
    .addFixtureFile("tests/status.json", "{\n  \"tests\": {\n    \"t1\": {\n      \"status\": \"certified\",\n      \"certificate\": {\n        \"skills\": {\n          \"move\": \"ac2f16c6915a548b041c3bfda8befa7dea01d3f3\"\n        }\n      }\n    }\n  }\n}\n")
    .setArgs("--fix", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: sync\nAll tracked files: 4 file(s)\nFixing 2 check(s) across 2 file(s)...\nSummary: 2 check(s), 1 passed, 1 fixed\nFixing completed.\nCompleted in <TIME>\n")
    .expectStderr("")
    .expectExitCode(0)
    .expectGeneratedFile("tests/status.json", "{\n  \"tests\": {\n    \"t1\": {\n      \"status\": \"new\"\n    }\n  }\n}\n");
});
