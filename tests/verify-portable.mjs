import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

const executable = path.resolve(`release/Agent-Foundry-${process.env.npm_package_version}-x64.exe`);
accessSync(executable, constants.R_OK);
execFileSync(executable, ["--smoke-test"], { windowsHide: true, stdio: "inherit", timeout: 60_000 });
console.log(`Portable desktop smoke passed: ${executable}`);
