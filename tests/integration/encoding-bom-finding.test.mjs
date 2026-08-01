import { defineIntegrationTest } from "./test-api.mjs";

export default defineIntegrationTest("encoding-bom-finding", (test) => {
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
        "name": "encoding",
        "export": "EncodingCheck",
        "modes": [
          "manual"
        ],
        "options": {
          "extensions": [
            ".txt"
          ],
          "encoding": "utf-8"
        }
      }
    ]
  })
    .addFixtureFile("src/a.txt", "﻿hello world\n")
    .setArgs("--lint", "--mode", "manual", "--show", "first", "--checks", "encoding", "--files", "src/a.txt")
    .expectStdout("Mode: manual | Source: All tracked files | Checks: encoding\nAll tracked files: 1 file(s)\n{\"startLine\":1,\"endLine\":1,\"snippet\":\"﻿hello world\\n\",\"message\":\"file starts with a UTF-8 BOM; BOMs are not allowed\"}\n")
    .expectStderr("")
    .expectExitCode(0);
});
