import assert from "node:assert/strict";
import test from "node:test";
import { groupTasksByProject } from "../../app/lib/task-groups.js";

type GroupTask = { id: string; workspacePath: string | null; projectWorkspacePath?: string | null; section?: string | null };

test("groups conversations by full project folder without merging same-named folders", () => {
  const tasks: GroupTask[] = [
    { id: "one", workspacePath: "C:\\work\\alpha" },
    { id: "two", workspacePath: "D:\\archive\\alpha" },
    { id: "three", workspacePath: "c:\\WORK\\alpha" },
  ];
  const groups = groupTasksByProject(tasks);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.tasks.map((task) => task.id)), [["one", "three"], ["two"]]);
});

test("keeps a worktree conversation with its originating project", () => {
  const tasks: GroupTask[] = [
    { id: "root", workspacePath: "E:\\projects\\agent" },
    { id: "branch", workspacePath: "E:\\data\\worktrees\\branch", projectWorkspacePath: "E:\\projects\\agent" },
  ];
  const groups = groupTasksByProject(tasks);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.label, "agent");
  assert.deepEqual(groups[0]?.tasks.map((task) => task.id), ["root", "branch"]);
});
