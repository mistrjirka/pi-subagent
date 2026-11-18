import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { AgentTelemetryService } from "../agent-telemetry.js";
import { interpretEvent } from "../event-interpret.js";
import { ExternalControlBridge } from "../external-control.js";

const bridges: ExternalControlBridge[] = [];
afterEach(() => {
	for (const bridge of bridges.splice(0)) bridge.cleanup();
});

function makeBridge() {
	const agent = {
		agentId: "trace",
		label: "implementer",
		startedAt: Date.now(),
		status: "running" as const,
		async sendMessage() {
			return true;
		},
		async stop() {},
	};
	const bridge = new ExternalControlBridge(agent, {
		profile: "implementer",
		parentPid: process.pid,
		treeId: "tree-unit",
		parentAgentId: "root",
	});
	bridges.push(bridge);
	return bridge;
}

describe("event-owned telemetry without session-file parsing", () => {
	it("reads assistant usage once from the finalized typed RPC event", () => {
		assert.deepEqual(
			interpretEvent({
				type: "message_end",
				message: {
					role: "assistant",
					usage: { input: 150, cacheRead: 900, cacheWrite: 20 },
				},
			}),
			[{ type: "assistant_end", windowTokens: 1070 }],
		);
		assert.deepEqual(
			interpretEvent({
				type: "message_end",
				message: {
					role: "assistant",
					usage: { input: -4, cacheRead: 100 },
				},
			}),
			[{ type: "assistant_end" }],
		);
		assert.deepEqual(interpretEvent({ type: "message_end", message: { role: "assistant" } }), [
			{ type: "assistant_end" },
		]);
	});

	it("tracks real executions and completed turns, not periodic heartbeats", () => {
		const telemetry = new AgentTelemetryService();
		assert.deepEqual(telemetry.snapshot(), { turnCount: 0, toolCount: 0 });
		assert.equal(telemetry.observe({ type: "assistant_start" }, 1000).changed, false);
		telemetry.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "code", argsPreview: "" }, 1100);
		telemetry.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "code", argsPreview: "" }, 1200);
		assert.equal(telemetry.snapshot().toolCount, 1);
		telemetry.observe({ type: "assistant_end", windowTokens: 26_000 }, 1300);
		telemetry.observe({ type: "tool_result_end", toolCallId: "t1", toolName: "code", isError: false }, 1400);
		assert.deepEqual(telemetry.snapshot(), {
			turnCount: 1,
			toolCount: 1,
			windowTokens: 26_000,
			lastActivityAt: 1400,
		});
		assert.equal(
			telemetry.observe({ type: "tool_execution_end", toolCallId: "t1", toolName: "code", isError: false }).emitStream,
			false,
		);
	});

	it("publishes progress in the status bridge without reading its session file", () => {
		const bridge = makeBridge();
		for (const event of interpretEvent({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input: 200, cacheRead: 500, cacheWrite: 0 },
			},
		}))
			bridge.appendEvents(event);
		for (const event of interpretEvent({
			type: "tool_execution_start",
			toolCallId: "work-1",
			toolName: "bash",
			args: {},
		}))
			bridge.appendEvents(event);
		const state = JSON.parse(fs.readFileSync(bridge.statusPath, "utf8"));
		assert.equal(state.turnCount, 1);
		assert.equal(state.toolCount, 1);
		assert.equal(state.windowTokens, 700);
		assert.equal(state.activeTools.length, 1);
		for (const event of interpretEvent({
			type: "tool_execution_end",
			toolCallId: "work-1",
			toolName: "bash",
			isError: false,
		}))
			bridge.appendEvents(event);
		const finished = JSON.parse(fs.readFileSync(bridge.statusPath, "utf8"));
		assert.equal(finished.activeTools, undefined);
		assert.equal(finished.toolCount, 1);
		assert.equal(finished.turnCount, 1);
	});
});
