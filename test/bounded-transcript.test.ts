import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatTranscript, IncrementalTranscriptCursor } from "../transcript.js";

describe("bounded persisted supervision", () => {
	it("pages a history larger than the RPC limit without fetching RPC", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-bounded-"));
		try {
			const path = join(dir, "session.jsonl");
			const records = Array.from({ length: 8 }, (_, i) => ({
				id: `e${i}`,
				type: "message",
				message: { role: "toolResult", toolName: "code", content: [{ type: "text", text: "x".repeat(400_000) }] },
			}));
			writeFileSync(path, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			const cursor = new IncrementalTranscriptCursor();
			const agent = {
				sessionPath: path,
				getEntries: async () => {
					assert.fail("Persisted reads must not request giant RPC history");
				},
			};
			const first = await cursor.read(agent, { maxMessages: 2, maxChars: 1000, perMessageChars: 200 });
			const second = await cursor.read(agent, { maxMessages: 2, maxChars: 1000, perMessageChars: 200 });
			assert.equal(first.source, "session");
			assert.equal(first.returnedMessages, 2);
			assert.equal(second.nextCursor, "e3");
			assert.ok(first.text.length <= 1000);
			assert.equal(first.hasMore, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("leaves a partial append unread until its newline arrives", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-append-"));
		try {
			const path = join(dir, "session.jsonl");
			const entry = JSON.stringify({ id: "a", type: "message", message: { role: "user", content: "hello" } });
			writeFileSync(path, entry.slice(0, 20));
			const cursor = new IncrementalTranscriptCursor();
			const first = await cursor.read({ sessionPath: path });
			assert.equal(first.returnedMessages, 0);
			appendFileSync(path, entry.slice(20) + "\n");
			const second = await cursor.read({ sessionPath: path });
			assert.equal(second.returnedMessages, 1);
			assert.match(second.text, /hello/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("charges expanded reasoning and omission markers to the final limit", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "x".repeat(70_000) },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
				],
			},
		];
		const text = formatTranscript(messages, { maxChars: 500, perMessageChars: 400 });
		assert.ok(text.length <= 500);
		assert.match(text, /tool call/);
	});
});
