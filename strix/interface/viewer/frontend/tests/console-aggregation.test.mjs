import assert from "node:assert/strict";
import test from "node:test";
import {
  activeJobsForProject,
  projectLabelForRun,
  runsForHistoryFilter,
  runsForProject,
} from "../src/lib/console-aggregation.ts";

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

test("history filters expose all five runs, two unassigned, and legacy ownership", () => {
  const projects = [
    { id: "bytedance", name: "ByteDance", run_names: ["legacy-byte"] },
    { id: "jdsrc", name: "JD SRC", run_names: [] },
  ];
  const runs = [
    { name: "byte-1", project_id: "bytedance" },
    { name: "byte-2", project_id: "bytedance" },
    { name: "jd-1", project_id: "jdsrc" },
    { name: "legacy-byte" },
    { name: "cli-unassigned" },
  ];

  assert.equal(runsForHistoryFilter("all", projects[0], runs).length, 5);
  assert.deepEqual(
    runsForHistoryFilter("project", projects[0], runs).map((run) => run.name),
    ["byte-1", "byte-2", "legacy-byte"],
  );
  assert.deepEqual(
    runsForHistoryFilter("unassigned", projects[0], runs).map((run) => run.name),
    ["legacy-byte", "cli-unassigned"],
  );
  assert.equal(projectLabelForRun(runs[3], projects), "ByteDance");
});

test("history remains visible without a selected project", () => {
  const runs = [
    { name: "run-1", project_id: "project" },
    { name: "run-2" },
    { name: "run-3" },
    { name: "run-4", project_id: "other" },
    { name: "run-5", project_id: "other" },
  ];

  assert.equal(runsForHistoryFilter("all", undefined, runs).length, 5);
  assert.equal(runsForHistoryFilter("project", undefined, runs).length, 0);
  assert.equal(runsForHistoryFilter("unassigned", undefined, runs).length, 2);
});
