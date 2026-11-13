import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completionContextContent } from "../notification.js";
import { AgentRegistry, type RegisteredAgent } from "../registry.js";
import type { AgentMessage } from "../protocol.js";

function fakeAgent(id: string): RegisteredAgent {
	return {
		agentId: id,
		label: id,
		status: "completed",
		stoppedByControl: false,
		markStopped() {},
		async stop() {},
	};
}

const completion = {
	status: "completed" as const,
	output: "Implemented and verified",
	stats: { tokens: 42, toolUses: 1, durationMs: 180 },
};

describe("eager parent tool-result delivery", () => {
	it("preserves child progress without duplicates or early notification", () => {
		const reg = new AgentRegistry({ notify() {}, supervisionIntervalMs: 0 });
		reg.queueParentMessageIfActive({ to: "@parent", from: "ana", message: "first", sentAt: 1 });
		reg.queueParentMessageIfActive({ to: "@parent", from: "ana", message: "second", sentAt: 2 });
		const first = reg.takePendingForToolResult();
		assert.deepEqual(
			first.messages.map((m) => m.message),
			["first", "second"],
		);
		assert.deepEqual(reg.takePendingForToolResult().messages, []);
		assert.deepEqual(reg.takePendingParentMessages(), []);
	});

	it("keeps overflow for later results and for idle fallback", () => {
		const reg = new AgentRegistry({ notify() {}, supervisionIntervalMs: 0 });
		for (let i = 0; i < 3; i++) reg.queueParentMessageIfActive({ to: "@parent", from: "ana", message: String(i) });
		assert.deepEqual(
			reg.takePendingForToolResult(2).messages.map((m) => m.message),
			["0", "1"],
		);
		assert.deepEqual(
			reg.takePendingParentMessages().map((m) => m.message),
			["2"],
		);
		assert.deepEqual(reg.takePendingForToolResult().messages, []);
		reg.parentBecameIdle();
		assert.equal(reg.queueParentMessageIfActive({ to: "@parent", from: "ana", message: "idle" }), false);
	});

	it("includes a completion once, then suppresses the late notification", async () => {
		const sent: string[] = [];
		const reg = new AgentRegistry({
			notify: (agent) => {
				sent.push(agent.agentId);
			},
			supervisionIntervalMs: 0,
		});
		const agent = fakeAgent("ana");
		reg.register(agent);
		await reg.complete(agent, completion);
		const first = reg.takePendingForToolResult();
		assert.equal(first.completions.length, 1);
		assert.equal(first.completions[0]?.completion.output, "Implemented and verified");
		assert.equal(reg.takePendingForToolResult().completions.length, 0);
		assert.equal(reg.peekSettlement("ana")?.deliveredInToolResult, true);
		reg.parentBecameIdle();
		assert.deepEqual(sent, []);
	});

	it("still notifies on idle when no tool result arrived", async () => {
		const sent: string[] = [];
		const reg = new AgentRegistry({
			notify: (agent) => {
				sent.push(agent.agentId);
			},
			supervisionIntervalMs: 0,
		});
		const agent = fakeAgent("ana");
		reg.register(agent);
		await reg.complete(agent, completion);
		reg.parentBecameIdle();
		assert.deepEqual(sent, ["ana"]);
		assert.deepEqual(reg.takePendingForToolResult().completions, []);
	});

	it("does not announce an agent_wait-consumed completion again", async () => {
		const sent: string[] = [];
		const reg = new AgentRegistry({
			notify: (agent) => {
				sent.push(agent.agentId);
			},
			supervisionIntervalMs: 0,
		});
		const agent = fakeAgent("ana");
		reg.register(agent);
		await reg.complete(agent, completion);
		assert.equal((await reg.waitForSettlement("ana"))?.completion.output, completion.output);
		assert.equal(reg.takePendingForToolResult().completions.length, 0);
		reg.parentBecameIdle();
		assert.deepEqual(sent, []);
	});

	it("delivers one child message to one of several concurrent agent_wait calls", async () => {
		const reg = new AgentRegistry({ notify() {}, supervisionIntervalMs: 0 });
		reg.register(fakeAgent("ana"));
		reg.register(fakeAgent("bob"));
		const a = reg.waitForSettlement("ana", undefined, 5000, true);
		const b = reg.waitForSettlement("bob", undefined, 5000, true);
		const first: AgentMessage = { to: "@parent", from: "bob", message: "status" };
		assert.equal(reg.wakeWaitForMessage(first), true);
		assert.deepEqual(await a, { kind: "message", message: first });
		assert.deepEqual(await b, { kind: "other_wait", reason: "message" });
		assert.equal(reg.wakeWaitForMessage(first), false);
	});

	it("parallel waits for one completion do not repeat its report", async () => {
		const reg = new AgentRegistry({ notify() {}, supervisionIntervalMs: 0 });
		reg.register(fakeAgent("ana"));
		const first = reg.waitForSettlement("ana", undefined, 5000, true);
		const second = reg.waitForSettlement("ana", undefined, 5000, true);
		reg.recordSettlement("ana", { completion });
		const received = await first;
		assert.ok(received && "completion" in received);
		assert.equal(received.completion.output, completion.output);
		assert.deepEqual(await second, { kind: "other_wait", reason: "completion" });
	});

	it("uses the same model-visible completion JSON for both delivery paths", () => {
		const text = completionContextContent(fakeAgent("ana"), completion);
		assert.deepEqual(JSON.parse(text), {
			status: "completed",
			agent_id: "@ana",
			result: "Implemented and verified",
			session_path: null,
		});
	});
});
