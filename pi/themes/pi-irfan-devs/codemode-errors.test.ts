import assert from "node:assert/strict";
import test from "node:test";
import { conciseError, priorCallsWarning } from "./codemode-errors.ts";

const screenshotFailure = "Script error: Error: Missing doc anchors\n    at <anonymous> (codemode.js:7:32)\n\nTool calls made before the failure (they are not undone):\nread (ok)";

test("screenshot failure keeps cause and prior-call warning without stack dump", () => {
	assert.equal(conciseError(screenshotFailure), "Missing doc anchors");
	assert.equal(priorCallsWarning(screenshotFailure, 1), "1 prior call · changes not undone");
	assert.equal(priorCallsWarning(screenshotFailure, 0), "Prior calls not undone · expand for details");
});

test("runtime error wins over printed output; error types remain meaningful", () => {
	assert.equal(conciseError("printed earlier\nScript error: TypeError: Invalid value\r\n  at worker"), "TypeError: Invalid value");
	assert.equal(conciseError("Script error: timed out"), "timed out");
	assert.equal(conciseError("file not found\n  at read"), "file not found");
	assert.equal(conciseError("  \n "), "Script failed");
});

test("prior calls remain visible without claiming success or rollback", () => {
	assert.equal(priorCallsWarning("Error: denied", 2), "2 prior calls · changes not undone");
	assert.equal(priorCallsWarning("Error: denied", 0), undefined);
});
