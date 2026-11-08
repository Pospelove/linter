import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("file-sync-leader-edit", (test) => {
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
    .addFixtureFile("deploy/k8s/api.yaml", "metadata:\n  labels:\n    app: api-v2\n")
    .addFixtureFile(".github/workflows/deploy.yml", "env:\n  SERVICE: api-v1\n")
    .setArgs("--lint", "--mode", "manual")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: sync\nAll tracked files: 4 file(s)\nLinting 3 check(s) across 3 file(s)...\nSummary: 3 check(s), 1 passed, 2 failed\nCompleted in <TIME>\n")
    .expectStderr("[FAIL] .github/workflows/deploy.yml [sync]\n  service name: 1 copy(ies) out of sync:\n  .github/workflows/deploy.yml:2: api is \"api-v1\", leader deploy/services.yaml:3 has \"api-v2\"\n[FAIL] deploy/services.yaml [sync]\n  service name: 1 copy(ies) out of sync:\n  .github/workflows/deploy.yml:2: api is \"api-v1\", leader deploy/services.yaml:3 has \"api-v2\"\n")
    .expectExitCode(1);
});
