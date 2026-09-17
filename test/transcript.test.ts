import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatTranscript, formatTranscriptMessage, getMonitoringTranscript } from "../transcript.js";

describe("transcript formatting", () => {
	it("shows user, assistant tool calls, and tool results while hiding raw thinking", () => {
		const messages = [
			{ role: "user", content: "implement it" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain of thought" },
					{ type: "text", text: "Inspecting files." },
					{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
				],
			},
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] },
		];
		const text = formatTranscript(messages);
		assert.match(text, /user: implement it/);
		assert.match(text, /assistant: \[thinking\]/);
		assert.match(text, /\[tool call\] read/);
		assert.match(text, /tool result \(read\): file body/);
		assert.doesNotMatch(text, /private chain of thought/);
	});

	it("returns the most recent messages and marks omitted history", () => {
		const messages = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const text = formatTranscript(messages, { maxMessages: 3 });
		assert.match(text, /earlier transcript omitted/);
		assert.doesNotMatch(text, /m0/);
		assert.match(text, /m5/);
		assert.match(text, /m7/);
	});

	it("marks failed tool results", () => {
		assert.equal(
			formatTranscriptMessage({
				role: "toolResult",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "boom" }],
			}),
			"tool result (bash ERROR): boom",
		);
	});
});

describe("monitoring transcript fallbacks", () => {
	it("uses live RPC messages when available", async () => {
		const snapshot = await getMonitoringTranscript({
			getMessages: async () => [{ role: "user", content: "live task" }],
		});
		assert.equal(snapshot.source, "rpc");
		assert.match(snapshot.text, /live task/);
	});

	it("falls back to the persisted session when get_messages fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-transcript-"));
		const sessionPath = join(dir, "child.jsonl");
		try {
			writeFileSync(
				sessionPath,
				`${[
					JSON.stringify({ type: "session", id: "s1" }),
					JSON.stringify({ type: "message", message: { role: "user", content: "persisted task" } }),
					JSON.stringify({
						type: "message",
						message: {
							role: "toolResult",
							toolName: "bash",
							isError: false,
							content: [{ type: "text", text: "build ok" }],
						},
					}),
				].join("\n")}\n`,
			);
			const snapshot = await getMonitoringTranscript({
				getMessages: async () => {
					throw new Error("RPC timeout waiting for get_messages");
				},
				sessionPath,
			});
			assert.equal(snapshot.source, "session");
			assert.match(snapshot.text, /get_messages unavailable/);
			assert.match(snapshot.text, /persisted task/);
			assert.match(snapshot.text, /build ok/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the live event trace when messages are empty", async () => {
		const snapshot = await getMonitoringTranscript({
			getMessages: async () => [],
			getEvents: () => [
				{ kind: "text", text: "Checking build." },
				{ kind: "tool", name: "bash", args: "npm run typecheck" },
			],
		});
		assert.equal(snapshot.source, "events");
		assert.match(snapshot.text, /Checking build/);
		assert.match(snapshot.text, /npm run typecheck/);
	});

	it("does not silently report an RPC failure as an empty transcript", async () => {
		const snapshot = await getMonitoringTranscript({
			getMessages: async () => {
				throw new Error("unsupported get_messages");
			},
		});
		assert.equal(snapshot.source, "none");
		assert.match(snapshot.text, /transcript unavailable/);
		assert.match(snapshot.text, /unsupported get_messages/);
	});
});
