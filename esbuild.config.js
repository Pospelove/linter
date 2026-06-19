import esbuild from "esbuild";
import fs from "fs";
import { execSync } from "child_process";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {}

// Pass --sourcemap to emit dist/linter.mjs.map (used by `yarn test:coverage`).
const withSourcemap = process.argv.includes("--sourcemap");

await esbuild.build({
  entryPoints: ["linter.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/linter.mjs",
  sourcemap: withSourcemap ? "linked" : false,
  define: {
    __LINTER_VERSION__: JSON.stringify(pkg.version),
    __LINTER_COMMIT__: JSON.stringify(commit),
  },
  banner: {
    // Shebang for global installs + restore __filename / __dirname and
    // a CJS-compatible require() so bundled CJS deps work at runtime.
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __createRequire } from "module";',
      'import { fileURLToPath as __fileURLToPath } from "url";',
      'import { dirname as __dirname_ } from "path";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});

console.log("Built dist/linter.mjs");
