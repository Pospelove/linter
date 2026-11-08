import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("file-sync-leader-fix", (test) => {
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
          "name": "service name",
          "leader": {
            "files": [
              "deploy/services.yaml"
            ],
            "yaml": "services.<key>.name"
          },
          "followers": [
            {
              "files": [
                "deploy/k8s/*.yaml"
              ],
              "yaml": "metadata.labels.app",
              "key": "api"
            },
            {
              "files": [
                ".github/workflows/deploy.yml"
              ],
              "regex": "SERVICE: (?<value>\\S+)",
              "key": "api"
            }
          ]
        }
      }
    ]
  })
    .addFixtureFile("deploy/services.yaml", "services:\n  api:\n    name: api-v2\n")
    .addFixtureFile("deploy/k8s/api.yaml", "metadata:\n  labels:\n    app: api-v1\n")
    .addFixtureFile(".github/workflows/deploy.yml", "env:\n  SERVICE: api-v1\n")
    .setArgs("--fix", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: sync\nAll tracked files: 4 file(s)\nFixing 3 check(s) across 3 file(s)...\nSummary: 3 check(s), 1 passed, 2 fixed\nFixing completed.\nCompleted in <TIME>\n")
    .expectStderr("")
    .expectExitCode(0)
    .expectGeneratedFile("deploy/k8s/api.yaml", "metadata:\n  labels:\n    app: api-v2\n")
    .expectGeneratedFile(".github/workflows/deploy.yml", "env:\n  SERVICE: api-v2\n");
});
