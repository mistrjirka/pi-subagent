import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childIdentityEnvironment } from "../spawn-identity.js";
import {
	parseToolGroups,
	registerChildToolSelection,
	selectChildTools,
	toolGroupsFromEnvironment,
} from "../tool-capabilities.js";

const tools = [
	"read",
	"write",
	"bash",
	"code",
	"session_search",
	"memory_search",
	"user_artifact",
	"agent_send",
	"ask_parent",
	"agent_spawn",
	"agent_wait",
	"agent_recover",
	"codegraph_search",
	"web_search",
	"mcp__godot_ai",
	"special",
];
describe("configured child tool exposure", () => {
	it("keeps old configuration and prunes only unavailable child management", () => {
		assert.deepEqual(
			selectChildTools(tools, undefined, true),
			tools.filter((tool) => tool !== "agent_recover"),
		);
		assert.ok(!selectChildTools(tools, undefined, false).includes("agent_spawn"));
		assert.ok(selectChildTools(tools, undefined, false).includes("mcp__godot_ai"));
	});
	it("keeps essential tools, selects groups and allows explicit installed tools", () => {
		const selected = selectChildTools(tools, ["discovery", "tool:special"], true);
		assert.ok(selected.includes("codegraph_search"));
		assert.ok(selected.includes("special"));
		assert.ok(selected.includes("session_search"));
		assert.ok(selected.includes("agent_send"));
		assert.ok(selected.includes("agent_wait"));
		assert.ok(!selected.includes("mcp__godot_ai"));
		assert.ok(!selected.includes("web_search"));
	});
	it("updates the active registry without inventing tools or activating disabled tools", () => {
		let start: (() => void) | undefined;
		let active = tools.filter((name) => name !== "web_search");
		const pi = {
			on: (_event: string, fn: () => void) => {
				start = fn;
			},
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
		} as unknown as ExtensionAPI;
		registerChildToolSelection(pi, ["web"], false);
		start?.();
		assert.ok(active.includes("read"));
		assert.ok(active.includes("ask_parent"));
		assert.ok(!active.includes("web_search"));
		assert.ok(!active.includes("agent_wait"));
	});
	it("never lets nested workers inherit the parent's group selection accidentally", () => {
		const inherited = { PI_SUBAGENT_TOOL_GROUPS: '["web"]' };
		const child = childIdentityEnvironment("x", { name: "explore", allowedSubagents: [] }, "tree", "p", undefined);
		assert.equal(toolGroupsFromEnvironment({ ...inherited, ...child }.PI_SUBAGENT_TOOL_GROUPS), undefined);
		assert.equal(
			childIdentityEnvironment("x", { name: "explore", allowedSubagents: [] }, "tree", "p", undefined, [])
				.PI_SUBAGENT_TOOL_GROUPS,
			"[]",
		);
	});
	it("rejects malformed selection and preserves explicit empty groups", () => {
		assert.deepEqual(parseToolGroups([]), []);
		assert.throws(() => parseToolGroups(["invalid"]), /toolGroups/);
		assert.throws(() => toolGroupsFromEnvironment("null"), /toolGroups/);
	});
});
