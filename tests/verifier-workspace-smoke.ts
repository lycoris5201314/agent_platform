import { Verifier } from "../server/verification/verifier.js";
import { createWorkspaceHandle } from "../server/workspace/wsl-workspace.js";

const root = process.cwd();
const result = await new Verifier().verify(createWorkspaceHandle(root, "native", ""), (phase, check) => {
  if (phase === "completed") console.log(`${check.status === "passed" ? "PASS" : "FAIL"} ${check.label} (${check.durationMs ?? 0}ms)`);
});
if (!result.passed) throw new Error(result.details);
console.log(`Workspace verifier smoke passed (${result.projectTypes.join(", ")}; ${result.checks.length} checks)`);
