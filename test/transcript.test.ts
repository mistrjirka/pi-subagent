import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTranscript, formatTranscriptMessage } from "../transcript.js";

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
