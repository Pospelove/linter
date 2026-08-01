import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("crlf-per-finding-show-all", (test) => {
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
        "name": "crlf",
        "export": "CrlfCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "extensions": [
            ".txt"
          ]
        }
      }
    ]
  })
    .addFixtureFile("src/a.txt", "line1\r\nline2\nline3\r\n")
    .setArgs("--lint", "--mode", "manual", "--show", "all", "--checks", "crlf", "--files", "src/a.txt")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: crlf\r\nAll tracked files: 1 file(s)\r\n[{\"startLine\":1,\"endLine\":1,\"snippet\":\"line1\\r\\nline2\\nline3\\r\",\"message\":\"contains CRLF line ending\"},{\"startLine\":3,\"endLine\":3,\"snippet\":\"line1\\r\\nline2\\nline3\\r\\n\",\"message\":\"contains CRLF line ending\"}]\r\n")
    .expectStderr("")
    .expectExitCode(0);
});
