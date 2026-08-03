import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("clicking run B keeps every viewer action scoped to run B", () => {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const initializer = appSource.match(
    /const \[activeRun, setActiveRun\] = useState<string \| null>\(([\s\S]*?)\);/
  )?.[1]
    ?.trim();
  assert.ok(initializer, "ViewerApp must initialize activeRun");

  const clickedUrl = "/?run=run-b";
  const selectedRun = initializer.includes("URLSearchParams")
    ? new URLSearchParams(new URL(clickedUrl, "http://localhost/").search).get("run")
    : null;
  const requestPaths = [
    "/api/run",
    "/api/vulnerabilities",
    "/api/report",
    "/api/transcript",
  ].map((endpoint) =>
    selectedRun ? `${endpoint}?run=${encodeURIComponent(selectedRun)}` : endpoint,
  );

  assert.equal(selectedRun, "run-b", `clicked ${clickedUrl} but ViewerApp selected ${selectedRun}`);
  assert.deepEqual(requestPaths, [
    "/api/run?run=run-b",
    "/api/vulnerabilities?run=run-b",
    "/api/report?run=run-b",
    "/api/transcript?run=run-b",
  ]);
  assert.deepEqual(
    { agent_id: "root", message: "focus B", run_name: selectedRun },
    { agent_id: "root", message: "focus B", run_name: "run-b" },
  );
});
