import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatMonitoringProgress, MonitoringProgressTracker } from "../monitoring-progress.js";
import { formatTranscript, IncrementalTranscriptCursor } from "../transcript.js";

describe("compact monitoring progress", () => {
	it("attributes successful direct and nested edits to the correct child, and reports incremental changes", () => {
		const a = new MonitoringProgressTracker("/repo");
		const b = new MonitoringProgressTracker("/repo");
		a.handle({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_THINKING" },
					{ type: "text", text: "Found the cause." },
					{ type: "toolCall", id: "1", name: "edit", arguments: { path: "src/a.ts" } },
					{ type: "toolCall", id: "2", name: "write", arguments: { path: "src/failed.ts" } },
				],
			},
		});
		a.handle({
			type: "message_end",
			message: { role: "toolResult", toolName: "edit", toolCallId: "1", isError: false, content: [] },
		});
		a.handle({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "write",
				toolCallId: "2",
				isError: true,
				content: [{ type: "text", text: "Write failed" }],
			},
		});
		a.handle({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "code",
				toolCallId: "3",
				isError: true,
				content: [],
				nestedCalls: {
					calls: [
						{ name: "edit", status: "ok", arguments: { path: "/repo/src/a.ts" } },
						{ name: "write", status: "ok", arguments: { path: "/repo/test/b.ts" } },
						{ name: "edit", status: "error", arguments: { path: "/repo/src/other.ts" } },
						{ name: "bash", status: "ok", arguments: { command: "echo x > not-attributed.ts" } },
					],
				},
			},
		});
		const p = a.snapshot();
		assert.deepEqual(p.editedFiles, ["src/a.ts", "test/b.ts"]);
		assert.equal(p.totalFiles, 2);
		assert.equal(p.shellCalls, 1);
		assert.match(formatMonitoringProgress(p), /Shell writes may be untracked/);
		assert.doesNotMatch(formatMonitoringProgress(p), /PRIVATE_THINKING|failed\.ts|other\.ts|not-attributed/);
		assert.deepEqual(b.snapshot().editedFiles, []);
		assert.deepEqual(a.snapshot().editedFiles, []);
		assert.equal(a.snapshot().totalFiles, 2);
		a.handle({ type: "tool_execution_start", toolCallId: "4", toolName: "edit", args: { path: "src/a.ts" } });
		a.handle({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "4", toolName: "edit", isError: false, content: [] },
		});
		assert.deepEqual(a.snapshot().editedFiles, ["src/a.ts"]);
		assert.equal(a.snapshot().totalFiles, 2);
	});

	it("keeps compact evidence bounded and full details available through an independent cursor", async () => {
		const messages = [
			{ role: "user", content: "PARENT_TASK" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "PRIVATE_THINKING" },
					{ type: "text", text: "Found the root cause" },
					{
						type: "toolCall",
						id: "1",
						name: "edit",
						arguments: { path: "src/a.ts", oldText: "LARGE_OLD_TEXT".repeat(200) },
					},
				],
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "RAW_SOURCE".repeat(400) }] },
			{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "IMPORTANT_FAILURE" }] },
		];
		const dir = mkdtempSync(join(tmpdir(), "pi-compact-monitoring-"));
		try {
			const sessionPath = join(dir, "child.jsonl");
			writeFileSync(
				sessionPath,
				messages.map((message, i) => JSON.stringify({ type: "message", id: "m" + i, message })).join("\n") + "\n",
			);
			const compact = new IncrementalTranscriptCursor();
			const full = new IncrementalTranscriptCursor();
			const agent = { sessionPath };
			const first = await compact.readRecent(agent, {
				detail: "recent",
				maxMessages: 8,
				maxChars: 2200,
				perMessageChars: 420,
			});
			assert.match(first.text, /IMPORTANT_FAILURE/);
			assert.match(first.text, /Found the root cause/);
			assert.match(first.text, /src\/a\.ts/);
			assert.doesNotMatch(first.text, /PRIVATE_THINKING|PARENT_TASK|LARGE_OLD_TEXT|RAW_SOURCE/);
			assert.ok(first.text.length <= 2200);
			const second = await compact.readRecent(agent, { detail: "recent" });
			assert.equal(second.returnedMessages, 0);
			const all = await full.read(agent, { detail: "full", maxMessages: 8, perMessageChars: 5000, maxChars: 20000 });
			assert.match(all.text, /PARENT_TASK/);
			assert.match(all.text, /PRIVATE_THINKING/);
			assert.match(all.text, /RAW_SOURCE/);
			assert.match(formatTranscript(messages), /RAW_SOURCE/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
