import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../index.js";

it("registers the same root tools after splitting message routing and controls", () => {
	const tools: string[] = [];
	const events: string[] = [];
	const pi = {
		on(event: string) {
			events.push(event);
		},
		registerTool(definition: { name: string }) {
			tools.push(definition.name);
		},
		registerMessageRenderer() {},
		events: { on() {} },
	} as unknown as ExtensionAPI;
	registerSubagents(pi);
	assert.deepEqual(tools.sort(), [
		"agent_inspect",
		"agent_list",
		"agent_recover",
		"agent_send",
		"agent_spawn",
		"agent_stop",
		"agent_wait",
	]);
	assert.ok(events.includes("agent_settled"));
	assert.ok(events.includes("tool_result"));
	assert.ok(events.includes("session_shutdown"));
});
