import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

assert.match(workflow, /tags:\s*\n\s*- "v\*"/, "Release workflow must be triggered only by version tags");
assert.match(workflow, /Tag \$env:RELEASE_TAG does not match package version/, "Release workflow must reject a mismatched tag");
for (const command of ["npm ci", "npm test", "npm run desktop:dist", "verify-unpacked-release.mjs", "verify-installer.mjs"]) {
  assert.ok(workflow.includes(command), `Release workflow is missing verification step: ${command}`);
}
for (const asset of ["x64.exe", "x64.exe.blockmap", "x64.exe.sha256", "release/latest.yml"]) {
  assert.ok(workflow.includes(asset), `Release workflow is missing release asset: ${asset}`);
}
assert.match(packageJson.scripts?.["desktop:runtime"] ?? "", /electron\/install\.js/, "Desktop builds must install the Electron runtime explicitly");
assert.match(packageJson.scripts?.["desktop:dist"] ?? "", /--publish never/, "Desktop builds must not publish before release verification finishes");
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
console.log(`Release workflow smoke passed for v${packageJson.version}.`);
