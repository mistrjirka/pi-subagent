import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { it } from "node:test";
import { MAX_RESULT_CHARS, resultOverflowMarker, resultPreview } from "../result-output.js";

it("bounds result previews while keeping recoverable evidence and stable references", () => {
	const text = "Outcome: blocked\n" + "evidence ".repeat(3000) + "\nRemaining: unresolved";
	const preview = resultPreview(text);
	assert.ok(preview.length <= MAX_RESULT_CHARS);
	assert.ok(preview.startsWith("Outcome: blocked"));
	assert.ok(preview.endsWith("Remaining: unresolved"));
	const marker = resultOverflowMarker("worker", text);
	const file = marker.match(/full output: (.+)\]/)?.[1];
	assert.ok(file);
	try {
		assert.equal(readFileSync(file, "utf8"), text);
		assert.equal(resultOverflowMarker("worker", text), marker);
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
});
