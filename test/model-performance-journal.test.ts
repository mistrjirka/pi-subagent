import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordSubagentPerformance } from "../model-performance-journal.js";
import { RequestPerformanceTracker } from "../request-performance.js";

test("separate child instances never mix streaming timings", () => {
	const children = [new RequestPerformanceTracker(), new RequestPerformanceTracker()];
	for (const [index, child] of children.entries()) {
		child.handle({ type: "turn_start" }, 1000 + index * 100);
		child.handle({ type: "message_start", message: { role: "assistant", provider: "test", model: "model" + index } }, 1100 + index * 100);
	}
	for (let i = 0; i < 9; i++) {
		children[0]!.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "x" } }, 2000 + i * 150);
		children[1]!.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y" } }, 2400 + i * 200);
	}
	for (const [index, child] of children.entries()) {
		const sample = child.handle({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { output: 50 + index } } }, 10_000);
		assert.deepEqual(sample, { provider: "test", modelId: "model" + index, ttftMs: index ? 1300 : 1000, generationMs: index ? 1600 : 1200, outputTokens: 50 + index });
	}
});

test("journal records only valid measured samples, prunes old daily files and stores no message text", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-performance-"));
	try {
		const now = Date.parse("2026-11-24T12:00:00Z");
		const sample = { provider: "test", modelId: "model", ttftMs: 800, generationMs: 1200, outputTokens: 48 };
		fs.writeFileSync(path.join(root, "2026-09-01.jsonl"), "old");
		fs.writeFileSync(path.join(root, "notes.txt"), "keep");
		recordSubagentPerformance(sample, now, root);
		recordSubagentPerformance({ ...sample, outputTokens: 80 }, now + 1, root);
		recordSubagentPerformance({ ...sample, generationMs: 0 }, now + 2, root);
		const rows = fs.readFileSync(path.join(root, "2026-11-24.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.deepEqual(rows, [
			{ version: 3, timestamp: now, ...sample },
			{ version: 3, timestamp: now + 1, ...sample, outputTokens: 80 },
		]);
		assert.equal(fs.existsSync(path.join(root, "2026-09-01.jsonl")), false);
		assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "keep");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
