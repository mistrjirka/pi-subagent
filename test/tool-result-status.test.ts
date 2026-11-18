import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { interpretEvent } from "../event-interpret.js";
import { ExternalControlBridge } from "../external-control.js";

const bridges: ExternalControlBridge[] = [];
afterEach(() => {
	for (const bridge of bridges.splice(0)) bridge.cleanup();
});

function bridge() {
	const agent = {
		agentId: "test-worker",
		label: "implementer",
		startedAt: Date.now(),
		status: "running" as const,
		async sendMessage() {
			return true;
		},
		async stop() {},
	};
	const result = new ExternalControlBridge(agent, {
		profile: "implementer",
		parentPid: process.pid,
		treeId: "tree-1",
		parentAgentId: "root",
	});
	bridges.push(result);
	return result;
}

function deliver(control: ExternalControlBridge, raw: Record<string, unknown>) {
	for (const event of interpretEvent({ type: "unused", ...raw })) control.appendEvents(event);
}

function statusTools(control: ExternalControlBridge) {
	return JSON.parse(fs.readFileSync(control.statusPath, "utf8")).activeTools ?? [];
}

function eventKinds(control: ExternalControlBridge) {
	control.flushEvents();
	return fs
		.readFileSync(control.eventsPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const event = JSON.parse(line);
			return [event.kind, event.toolCallId];
		});
}

describe("finalized tool results clear phantom active commands", () => {
	it("closes a completed code call even without a tool_execution_end", () => {
		const control = bridge();
		deliver(control, { type: "tool_execution_start", toolCallId: "code-call", toolName: "code", args: {} });
		assert.deepEqual(
			statusTools(control).map((item: { toolCallId: string }) => item.toolCallId),
			["code-call"],
		);
		deliver(control, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "code-call",
				toolName: "code",
				content: [{ type: "text", text: "finished" }],
				details: { state: "heavy resumable state" },
			},
		});
		assert.deepEqual(statusTools(control), []);
		assert.deepEqual(eventKinds(control), [
			["tool_start", "code-call"],
			["tool_end", "code-call"],
		]);
	});

	it("does not report duplicate completions when tool_execution_end was already received", () => {
		const control = bridge();
		deliver(control, { type: "tool_execution_start", toolCallId: "bash-call", toolName: "bash", args: {} });
		deliver(control, { type: "tool_execution_end", toolCallId: "bash-call", toolName: "bash", isError: false });
		deliver(control, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "bash-call",
				toolName: "bash",
			},
		});
		assert.deepEqual(statusTools(control), []);
		assert.deepEqual(eventKinds(control), [
			["tool_start", "bash-call"],
			["tool_end", "bash-call"],
		]);
	});

	it("ignores unrelated or incomplete result events while preserving a real running command", () => {
		const control = bridge();
		deliver(control, { type: "tool_execution_start", toolCallId: "running-call", toolName: "code", args: {} });
		deliver(control, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "other-call",
				toolName: "code",
			},
		});
		deliver(control, {
			type: "message_start",
			message: {
				role: "toolResult",
				toolCallId: "running-call",
				toolName: "code",
			},
		});
		deliver(control, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "running-call",
			},
		});
		deliver(control, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "running-call",
				toolName: "read",
			},
		});
		assert.equal(statusTools(control).length, 1);
		deliver(control, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "running-call",
				toolName: "code",
				isError: true,
			},
		});
		assert.deepEqual(statusTools(control), []);
	});
});
