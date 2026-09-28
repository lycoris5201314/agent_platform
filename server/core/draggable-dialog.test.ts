import assert from "node:assert/strict";
import test from "node:test";
import { clampDialogDelta } from "../../app/lib/use-draggable-dialog.js";

test("keeps a dragged dialog inside the visible window", () => {
  const rect = { left: 200, top: 100, right: 700, bottom: 500 };
  assert.deepEqual(clampDialogDelta(rect, 120, 80, { width: 900, height: 700 }), { x: 120, y: 80 });
  assert.deepEqual(clampDialogDelta(rect, -500, -500, { width: 900, height: 700 }), { x: -192, y: -92 });
  assert.deepEqual(clampDialogDelta(rect, 500, 500, { width: 900, height: 700 }), { x: 192, y: 192 });
});
