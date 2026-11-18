import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentCompletion } from "../agent-process.js";
import { notifyCompletion } from "../notification.js";
import type { AgentMessage } from "../protocol.js";
import { AgentRegistry, type RegisteredAgent } from "../registry.js";

function fakeAgent(id: string, persistent = true): RegisteredAgent {
	return {
		agentId: id,
		label: "Implementer",
		persistent,
		status: "completed",
		stoppedByControl: false,
		async sendMessage() {
			return true;
		},
		async stop() {},
		markStopped() {},
	};
}
const finished: AgentCompletion = {
	status: "completed",
	output: "Final source changes verified and tests pass",
	stats: { tokens: 100, toolUses: 5, durationMs: 8_000 },
};
function message(from: string, text = "Final source update ready"): AgentMessage {
	return { from, to: "@parent", message: text, sentAt: 200 };
}
function fixture() {
	const sent: Array<{ id: string; triggerTurn: boolean; output: string }> = [];
	const registry = new AgentRegistry({
		notify: (agent, completion, delivery) => {
			sent.push({ id: agent.agentId, triggerTurn: delivery.triggerTurn, output: completion.output });
		},
		supervisionIntervalMs: 0,
	});
	return { registry, sent };
}

describe("completion notifications after parent-visible progress", () => {
	it("does not wake the parent after its tool result included that child's progress", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.queueParentMessageIfActive(message("rona"));
		const { messages } = registry.takePendingForToolResult();
		assert.equal(messages.length, 1);
		await registry.complete(child, finished);
		assert.deepEqual(sent, [], "wait for the safe parent boundary");
		registry.parentBecameIdle();
		assert.deepEqual(sent, [
			{
				id: "rona",
				triggerTurn: false,
				output: finished.output,
			},
		]);
		assert.equal(registry.peekSettlement("rona")?.completion.output, finished.output);
	});

	it("matches Rona's ordering: settlement before progress becomes visible", async () => {
		const { registry, sent } = fixture();
		registry.register(fakeAgent("rona"));
		const progress = message("rona", "Final source update ready");
		registry.queueParentMessageIfActive(progress);
		await registry.complete(registry.lookup("rona")!, finished);
		assert.equal(sent.length, 0);
		// Pi's turn_end sends the buffered progress to the parent before agent_settled.
		for (const item of registry.takePendingParentMessages()) registry.noteDeliveredParentMessage(item);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[false],
		);
		registry.parentBecameIdle();
		assert.equal(sent.length, 1, "a second idle signal cannot replay the card");
	});

	it("agent_settled accounts for buffered progress before the completion fallback", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.queueParentMessageIfActive(message("rona"));
		await registry.complete(child, finished);
		// No turn_end occurred. Only agent_settled can flush this progress.
		for (const msg of registry.takePendingParentMessages()) registry.noteDeliveredParentMessage(msg);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[false],
		);
	});

	it("the real agent_settled hook marks delivered progress before the idle fallback", () => {
		const source = readFileSync(new URL("../parent-delivery.ts", import.meta.url), "utf8");
		const start = source.indexOf('pi.on("agent_settled", () => {');
		const end = source.indexOf("\n\t});", start);
		assert.ok(start >= 0 && end > start);
		const handler = source.slice(start, end);
		const deliveredAt = handler.indexOf("registry.noteDeliveredParentMessage(message)");
		const idleAt = handler.indexOf("registry.parentBecameIdle()");
		assert.ok(deliveredAt >= 0 && idleAt > deliveredAt);
	});

	it("does wake the parent if progress was only queued but never delivered", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.queueParentMessageIfActive(message("rona"));
		await registry.complete(child, finished);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[true],
		);
	});

	it("does not mistake diagnostic pings for useful progress", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.noteDeliveredParentMessage({ ...message("rona"), kind: "diagnostic" });
		await registry.complete(child, finished);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[true],
		);
	});

	it("preserves proactive wake when another child reported progress", async () => {
		const { registry, sent } = fixture();
		const rona = fakeAgent("rona");
		const aria = fakeAgent("aria");
		registry.register(rona);
		registry.register(aria);
		registry.noteDeliveredParentMessage(message("aria"));
		await registry.complete(rona, finished);
		registry.parentBecameIdle();
		assert.deepEqual(sent, [{ id: "rona", triggerTurn: true, output: finished.output }]);
	});

	it("resets progress receipts when a resident child starts another turn", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.noteDeliveredParentMessage(message("rona"));
		await registry.complete(child, finished);
		registry.parentBecameIdle();
		assert.equal(sent.at(-1)?.triggerTurn, false);
		const accepted = await registry.deliver("rona", "continue");
		assert.equal(accepted, true);
		registry.parentBecameActive();
		await registry.complete(child, { ...finished, output: "Next independent task done" });
		registry.parentBecameIdle();
		assert.equal(sent.at(-1)?.triggerTurn, true, "old progress must not suppress a new task");
		assert.equal(sent.length, 2);
	});

	it("restores progress receipt if a child rejects a new agent_send", async () => {
		const { registry, sent } = fixture();
		const agent: RegisteredAgent = {
			...fakeAgent("rona"),
			status: "running",
			async sendMessage() {
				return false;
			},
		};
		registry.register(agent);
		registry.noteDeliveredParentMessage(message("rona"));
		assert.equal(await registry.deliver("rona", "new task"), false);
		await registry.complete(agent, finished);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[false],
		);
	});

	it("a progress message consumed by a parallel agent_wait suppresses its later duplicate wake", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.register(fakeAgent("aria"));
		const waiting = registry.waitForSettlement("aria", undefined, 500, true);
		assert.equal(registry.wakeWaitForMessage(message("rona")), true);
		const observed = await waiting;
		assert.ok(observed && "kind" in observed && observed.kind === "message");
		await registry.complete(child, finished);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[false],
		);
	});

	it("ignores progress events from unknown children", async () => {
		const { registry, sent } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.noteDeliveredParentMessage(message("unknown"));
		await registry.complete(child, finished);
		registry.parentBecameIdle();
		assert.deepEqual(
			sent.map((item) => item.triggerTurn),
			[true],
		);
	});

	it("keeps urgent ask_parent delivery immediate and independent of passive completions", () => {
		const { registry } = fixture();
		const child = fakeAgent("rona");
		registry.register(child);
		registry.noteDeliveredParentMessage(message("rona"));
		let questions = 0;
		registry.recordSettlement(
			"rona",
			{
				completion: finished,
				waitingForParent: true,
				question: { from: "rona", question: "Approve action?" },
			},
			() => {
				questions++;
			},
		);
		assert.equal(questions, 1, "an urgent question does not wait for parent-idle");
		registry.parentBecameIdle();
		assert.equal(questions, 1);
	});
});

describe("Pi custom-message delivery contract", () => {
	it("sends a passive visible completion without creating an extra model turn", () => {
		const calls: Array<{ message: unknown; options: unknown }> = [];
		const pi = {
			sendMessage(message: unknown, options: unknown) {
				calls.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		notifyCompletion(pi, fakeAgent("rona"), finished, { triggerTurn: false });
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0]?.options, { deliverAs: "steer", triggerTurn: false });
		const notice = calls[0]?.message as {
			display: boolean;
			customType: string;
			details: { result: string };
			content: string;
		};
		assert.equal(notice.display, true);
		assert.equal(notice.customType, "subagent-notification");
		assert.equal(notice.details.result, finished.output);
		assert.equal(JSON.parse(notice.content).result, finished.output);
	});

	it("leaves ordinary unread completions waking the parent by default", () => {
		const options: unknown[] = [];
		const pi = {
			sendMessage(_message: unknown, opt: unknown) {
				options.push(opt);
			},
		} as unknown as ExtensionAPI;
		notifyCompletion(pi, fakeAgent("rona"), finished);
		assert.deepEqual(options, [{ deliverAs: "steer", triggerTurn: true }]);
	});
});
