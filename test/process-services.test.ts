import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentActivityFold } from "../agent-activity-fold.js";
import { AgentSettlementLatch } from "../agent-settlement-latch.js";
import type { AgentActivity, AgentEvent } from "../event-interpret.js";

describe("AgentActivityFold", () => {
	it("folds consecutive thinking/text chunks and preserves callback order", () => {
		const calls: string[] = [];
		const activities: AgentActivity[] = [];
		const fold = new AgentActivityFold({
			onDelta: (delta) => calls.push("delta:" + delta),
			onActivityChange: (activity) => {
				activities.push(activity);
				calls.push("activity:" + activity.kind);
			},
			onStream: (event) => calls.push("stream:" + event.type),
		});
		const events: AgentEvent[] = [
			{ type: "assistant_start" },
			{ type: "thinking", text: "first" },
			{ type: "thinking", text: " second" },
			{ type: "text_delta", delta: "hello" },
			{ type: "text_delta", delta: " world" },
			{ type: "tool_call", activity: { kind: "tool", name: "read", args: "/tmp/file", id: "call-1" } },
			{ type: "assistant_end", windowTokens: 900 },
		];
		for (const event of events) assert.equal(fold.handle(event), true);
		assert.deepEqual(
			fold.getEvents().map((event) => [event.kind, event.kind === "tool" ? undefined : event.text]),
			[
				["thinking", "first second"],
				["text", "hello world"],
				["tool", undefined],
			],
		);
		assert.deepEqual(fold.latestActivity(), { kind: "tool", name: "read", args: "/tmp/file", id: "call-1" });
		assert.deepEqual(
			activities.map((item) => item.kind),
			["thinking", "thinking", "tool"],
		);
		assert.deepEqual(calls, [
			"stream:assistant_start",
			"activity:thinking",
			"stream:thinking",
			"activity:thinking",
			"stream:thinking",
			"delta:hello",
			"stream:text_delta",
			"delta: world",
			"stream:text_delta",
			"activity:tool",
			"stream:tool_call",
			"stream:assistant_end",
		]);
	});

	it("does not fold tool execution markers into visible tool calls", () => {
		const fold = new AgentActivityFold();
		assert.equal(
			fold.handle({ type: "tool_execution_start", toolCallId: "id", toolName: "bash", argsPreview: "echo a" }),
			true,
		);
		assert.equal(fold.handle({ type: "tool_execution_end", toolCallId: "id", toolName: "bash", isError: false }), true);
		assert.deepEqual(fold.getEvents(), []);
		assert.equal(fold.latestActivity(), undefined);
		assert.equal(fold.handle({ type: "agent_failed", error: "failure" }), false);
		assert.equal(fold.handle({ type: "settled" }), false);
	});

	it("preserves stable mutable event-array identity for the live widget", () => {
		const fold = new AgentActivityFold();
		const trace = fold.getEvents();
		fold.handle({ type: "text_delta", delta: "a" });
		fold.handle({ type: "text_delta", delta: "b" });
		assert.equal(fold.getEvents(), trace);
		assert.equal(trace.length, 1);
		assert.equal(trace[0]?.kind, "text");
		if (trace[0]?.kind === "text") assert.equal(trace[0].text, "ab");
	});
});

describe("AgentSettlementLatch", () => {
	it("remembers a settle that arrived before the consumer attached", async () => {
		const gate = new AgentSettlementLatch();
		gate.settle();
		assert.equal(gate.count, 1);
		await gate.waitForNext(() => false);
		assert.equal(gate.count, 1);
	});

	it("ignores old revisions when a persistent worker is woken", async () => {
		const gate = new AgentSettlementLatch();
		gate.settle();
		gate.ignorePrior();
		let settled = false;
		const waiting = gate
			.waitForNext(() => false)
			.then(() => {
				settled = true;
			});
		await Promise.resolve();
		assert.equal(settled, false);
		gate.settle();
		await waiting;
		assert.equal(settled, true);
	});

	it("releases parallel waiters once and skips waiting after process closure", async () => {
		const gate = new AgentSettlementLatch();
		const first = gate.waitForNext(() => false);
		const second = gate.waitForNext(() => false);
		gate.settle();
		await Promise.all([first, second]);
		await gate.waitForNext(() => true);
		assert.equal(gate.count, 1);
	});
});
