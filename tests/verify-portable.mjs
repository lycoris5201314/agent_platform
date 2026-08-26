import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";

const packageVersion = process.env.npm_package_version ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const executable = path.resolve(`release/Agent-Foundry-Portable-${packageVersion}-x64.exe`);
accessSync(executable, constants.R_OK);
execFileSync(executable, ["--smoke-test"], { windowsHide: true, stdio: "inherit", timeout: 120_000 });
console.log(`Portable desktop smoke passed: ${executable}`);
