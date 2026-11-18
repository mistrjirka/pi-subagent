import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiscoveryTools } from "../discovery-tools.js";
import { type AgentTreeEvent, TREE_STATUS_KEY } from "../event-interpret.js";
import { AgentRegistry } from "../registry.js";
import { createTreeTelemetry } from "../tree-telemetry.js";

describe("read-only discovery tool registration", () => {
	it("registers agent_list without recovery for nested children", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const pi = {
			registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;
		const registry = new AgentRegistry({ notify: () => {}, supervisionIntervalMs: 0 });
		registerDiscoveryTools(pi, {
			registry,
			toErrorResult: (error) => ({
				content: [{ type: "text", text: String(error) }],
				details: { error: String(error) },
				isError: true,
			}),
		});
		assert.deepEqual([...tools.keys()], ["agent_list"]);
		const result = await tools.get("agent_list")?.execute("id", { limit: 7 });
		assert.ok(result);
		assert.equal((result as { details: { limit: number } }).details.limit, 7);
	});

	it("caps the list size to one hundred", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const pi = {
			registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;
		registerDiscoveryTools(pi, {
			registry: { describeMessageTargets: (_value: string, limit: number) => "limit=" + limit },
			toErrorResult: (error) => ({
				content: [{ type: "text", text: String(error) }],
				details: { error: String(error) },
				isError: true,
			}),
		});
		const result = await tools.get("agent_list")?.execute("id", { limit: 1000 });
		assert.ok(result);
		assert.deepEqual((result as { details: { limit: number } }).details, { limit: 100 });
	});
});

describe("nested agent telemetry", () => {
	it("reports only tracked children and preserves their real parent id", () => {
		const events: AgentTreeEvent[] = [];
		const tree = createTreeTelemetry(true, "parent", (key, value) => {
			assert.equal(key, TREE_STATUS_KEY);
			events.push(JSON.parse(value) as AgentTreeEvent);
		});
		const agent = {
			agentId: "chi",
			label: "Implementer",
			startedAt: 123,
			getLatestActivity: () => ({ kind: "thinking" as const, text: "working" }),
		};
		tree.activity(agent);
		assert.equal(events.length, 0);
		tree.add(agent, "running");
		tree.activity(agent);
		tree.remove("chi", "done");
		tree.activity(agent);
		assert.deepEqual(
			events.map((event) => event.op),
			["add", "activity", "remove"],
		);
		assert.deepEqual(events[0], {
			op: "add",
			id: "chi",
			label: "Implementer",
			startedAt: 123,
			depth: 1,
			status: "running",
			parent: "parent",
		});
	});

	it("keeps root children off the upwards-only status channel", () => {
		const events: AgentTreeEvent[] = [];
		const tree = createTreeTelemetry(false, "", (_key, value) => {
			events.push(JSON.parse(value) as AgentTreeEvent);
		});
		tree.add({ agentId: "kai", label: "Reviewer", startedAt: 1 }, "running");
		tree.remove("kai", "done");
		assert.deepEqual(events, []);
	});
});
