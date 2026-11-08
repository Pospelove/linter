import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("file-sync-extractors", (test) => {
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
        "name": "blob",
        "export": "FileSyncCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "leader": {
            "files": [
              "skills/**/*.lua"
            ],
            "blobHash": true
          },
          "followers": [
            {
              "files": [
                "status.json"
              ],
              "json": "skills.<key>"
            }
          ]
        }
      },
      {
        "name": "ports",
        "export": "FileSyncCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "name": "port",
          "leader": {
            "files": [
              "status.json"
            ],
            "json": "ports.*.port",
            "key": "http"
          },
          "followers": [
            {
              "files": [
                "compose.yaml"
              ],
              "yaml": "services.*.ports.*.port",
              "key": "http"
            },
            {
              "files": [
                "ports.env"
              ],
              "regex": "^PORT_(?<key>\\w+)=(?<value>\\d+)$"
            },
            {
              "files": [
                "ports.tsv.sh"
              ],
              "command": "sh {file}"
            }
          ]
        }
      }
    ]
  })
    .addFixtureFile("skills/move.lua", "return { move = 1 }\n")
    .addFixtureFile("skills/sub/jump.lua", "return 2\n")
    .addFixtureFile("status.json", "{\n  \"skills\": {\n    \"move\": \"ac2f16c6915a548b041c3bfda8befa7dea01d3f3\",\n    \"jump\": \"a4325f6293bce320febf15940fbadc254c8edc95\"\n  },\n  \"ports\": [\n    {\n      \"name\": \"http\",\n      \"port\": 8080\n    }\n  ]\n}\n")
    .addFixtureFile("compose.yaml", "services:\n  web:\n    ports:\n      - name: http\n        port: 8081\n---\nextra: 1\n")
    .addFixtureFile("ports.env", "PORT_http=8082\n")
    .addFixtureFile("ports.tsv.sh", "printf 'http\\t8083\\t1\\n'\n")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: blob, ports\nAll tracked files: 7 file(s)\nLinting 7 check(s) across 6 file(s)...\nSummary: 7 check(s), 1 passed, 6 failed\nCompleted in <TIME>\n")
    .expectStderr("[FAIL] skills/sub/jump.lua [blob]\n  synced value: 1 copy(ies) out of sync:\n  status.json:4: jump is \"a4325f6293bce320febf15940fbadc254c8edc95\", leader skills/sub/jump.lua:1 has \"3ee3fcaa14dc40c165af86b222d0a6fc8234f6bf\"\n[FAIL] status.json [blob]\n  synced value: 1 copy(ies) out of sync:\n  status.json:4: jump is \"a4325f6293bce320febf15940fbadc254c8edc95\", leader skills/sub/jump.lua:1 has \"3ee3fcaa14dc40c165af86b222d0a6fc8234f6bf\"\n[FAIL] status.json [ports]\n  port: 3 copy(ies) out of sync:\n  compose.yaml:5: http is \"8081\", leader status.json:9 has \"8080\"\n  ports.env:1: http is \"8082\", leader status.json:9 has \"8080\"\n  ports.tsv.sh:1: http is \"8083\", leader status.json:9 has \"8080\"\n[FAIL] compose.yaml [ports]\n  port: 1 copy(ies) out of sync:\n  compose.yaml:5: http is \"8081\", leader status.json:9 has \"8080\"\n[FAIL] ports.env [ports]\n  port: 1 copy(ies) out of sync:\n  ports.env:1: http is \"8082\", leader status.json:9 has \"8080\"\n[FAIL] ports.tsv.sh [ports]\n  port: 1 copy(ies) out of sync:\n  ports.tsv.sh:1: http is \"8083\", leader status.json:9 has \"8080\"\n")
    .expectExitCode(1);
});
