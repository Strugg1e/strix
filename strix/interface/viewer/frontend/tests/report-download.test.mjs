import assert from "node:assert/strict";
import test from "node:test";
import {
  reportDownloadPath,
  reportFilenameFromContentDisposition,
} from "../src/lib/report-download.ts";

test("report downloads keep the selected run in the local endpoint query", () => {
  assert.equal(reportDownloadPath(), "/api/report/download");
  assert.equal(
    reportDownloadPath("run B/with spaces"),
    "/api/report/download?run=run%20B%2Fwith%20spaces",
  );
});

test("download filenames accept PDF response headers and fail closed", () => {
  assert.equal(
    reportFilenameFromContentDisposition('attachment; filename="strix-report-run.pdf"'),
    "strix-report-run.pdf",
  );
  assert.equal(
    reportFilenameFromContentDisposition('attachment; filename="../run.pdf"'),
    "__run.pdf",
  );
  assert.equal(reportFilenameFromContentDisposition("attachment; filename=report.txt"), "strix-report.pdf");
  assert.equal(reportFilenameFromContentDisposition(null), "strix-report.pdf");
});
