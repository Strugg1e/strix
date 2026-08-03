import assert from "node:assert/strict";
import test from "node:test";
import { activeJobsForProject, runsForProject } from "../src/lib/console-aggregation.ts";

test("task-side project metadata wins over legacy run_names", () => {
  const project = { id: "bytedance", run_names: ["legacy"] };
  const runs = [
    { name: "jds-1", project_id: "jdsrc" },
    { name: "byte-1", project_id: "bytedance" },
    { name: "legacy" },
  ];
  assert.deepEqual(
    runsForProject(project, runs).map((run) => run.name),
    ["byte-1", "legacy"]
  );
});

test("active task counts are scoped to the selected project", () => {
  const jobs = [{ project_id: "bytedance" }, { project_id: "jdsrc" }];
  assert.equal(activeJobsForProject("bytedance", jobs).length, 1);
});

