import { Verifier } from "../server/verification/verifier.js";
import { toWslPath } from "../server/workspace/wsl-workspace.js";

const root = process.cwd();
const result = await new Verifier().verify({
  windowsPath: root,
  wslPath: toWslPath(root),
  distro: process.env.WSL_DISTRO ?? "Ubuntu-24.04",
}, (phase, check) => {
  if (phase === "completed") console.log(`${check.status === "passed" ? "PASS" : "FAIL"} ${check.label} (${check.durationMs ?? 0}ms)`);
});
if (!result.passed) throw new Error(result.details);
console.log(`Workspace verifier smoke passed (${result.projectTypes.join(", ")}; ${result.checks.length} checks)`);
