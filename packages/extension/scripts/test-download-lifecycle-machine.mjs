import assert from "node:assert/strict";

import {
  downloadBasename,
  downloadStatusFromChromeState,
  matchingDownloadOwnerIndex,
} from "../dist/lifecycle/download_lifecycle_machine.js";

assert.equal(downloadStatusFromChromeState("complete"), "complete");
assert.equal(downloadStatusFromChromeState("interrupted"), "failed");
assert.equal(downloadStatusFromChromeState("in_progress"), undefined);
assert.equal(downloadStatusFromChromeState(undefined), undefined);

assert.equal(downloadBasename("/Users/me/Downloads/report.pdf"), "report.pdf");
assert.equal(downloadBasename("C:\\Users\\me\\Downloads\\report.pdf"), "report.pdf");
assert.equal(downloadBasename("report.pdf"), "report.pdf");

assert.equal(
  matchingDownloadOwnerIndex(
    [
      { suggestedFilename: "first.csv" },
      { suggestedFilename: "nested/second.csv" },
    ],
    { filename: "/tmp/second.csv" },
  ),
  1,
);
assert.equal(matchingDownloadOwnerIndex([{ suggestedFilename: "first.csv" }], { filename: "/tmp/none.csv" }), -1);
assert.equal(matchingDownloadOwnerIndex([{ suggestedFilename: "first.csv" }], {}), -1);
