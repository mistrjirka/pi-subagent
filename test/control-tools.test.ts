import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type ControlToolsPorts, registerControlTools } from "../control-tools.js";
import { MSG_STATUS_KEY, QUESTION_STATUS_KEY } from "../event-interpret.js";
import { type MessageRouteResult, MessageRouter } from "../message-router.js";
import { AgentRegistry, type RegisteredAgent } from "../registry.js";

function child(agentId = "bria", awaitingParent = false): RegisteredAgent {
	return {
		agentId,
		label: "Implementer",
		status: "running",
		awaitingParent,
		stoppedByControl: false,
		stop: async () => {},
		markStopped() {},
		sendMessage: async () => true,
	};
}

function registry(hasParent = false): AgentRegistry {
	return new AgentRegistry({ notify: () => {}, hasParent, supervisionIntervalMs: 0 });
}

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};
type RegisteredTool = {
	name: string;
	execute(
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: ((value: unknown) => void) | undefined,
		ctx: { mode: string; ui: ExtensionUIContext },
	): Promise<unknown>;
};

function harness(hasParent = false) {
	const registered = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: unknown) {
			const item = tool as RegisteredTool;
			registered.set(item.name, item);
		},
	} as ExtensionAPI;
	const workerRegistry = registry(hasParent);
	const routed: Array<{ message: unknown; outbound: boolean; answer: boolean | undefined }> = [];
	const removed: string[] = [];
	const retired: string[] = [];
	const statuses: Array<{ key: string; value: string }> = [];
	let routedResponse: MessageRouteResult = { ok: true, verb: "accepted" };
	const ports: ControlToolsPorts = {
		registry: workerRegistry,
		agentId: hasParent ? "root-child" : "",
		hasParent,
		captureUi: () => {},
		setStatus: (key, value) => statuses.push({ key, value }),
		routeMessage: async (message, outbound, answer) => {
			routed.push({ message, outbound, answer });
			return routedResponse;
		},
		removeFromTree: (id) => removed.push(id),
		retireRecovery: (id) => retired.push(id),
		toErrorResult: (err) => {
			const error = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: error }], details: { error }, isError: true };
		},
	};
	registerControlTools(pi, ports);
	async function run(name: string, params: Record<string, unknown>): Promise<ToolResult> {
		const tool = registered.get(name);
		assert.ok(tool, `expected tool ${name}`);
		const output = await tool.execute("call-1", params, new AbortController().signal, undefined, {
			mode: "rpc",
			ui: {} as ExtensionUIContext,
		});
		return output as ToolResult;
	}
	return {
		registered,
		workerRegistry,
		routed,
		removed,
		retired,
		statuses,
		run,
		setRoutedResponse(value: MessageRouteResult) {
			routedResponse = value;
		},
	};
}

describe("MessageRouter", () => {
	it("sends direct-child instructions through the registry and keeps the queued/accepted meaning", async () => {
		const r = registry();
		const sent: string[] = [];
		const w = child();
		w.sendMessage = async (text) => {
			sent.push(text);
			return true;
		};
		r.register(w);
		const router = new MessageRouter(
			{ sendMessage: () => {} } as Pick<ExtensionAPI, "sendMessage">,
			r,
			() => undefined,
		);
		assert.deepEqual(await router.route({ from: "", to: "bria", message: "Continue" }, true), {
			ok: true,
			verb: "queued",
		});
		assert.deepEqual(sent, ["Continue"]);
		w.status = "completed";
		assert.deepEqual(await router.route({ from: "", to: "bria", message: "Next" }, true), {
			ok: true,
			verb: "accepted",
		});
		assert.deepEqual(sent, ["Continue", "Next"]);
	});

	it("requires a live child status channel when sending upward", async () => {
		const r = registry(true);
		const router = new MessageRouter(
			{ sendMessage: () => {} } as Pick<ExtensionAPI, "sendMessage">,
			r,
			() => undefined,
		);
		const outcome = await router.route({ from: "chi", to: "@parent", message: "Progress" }, true);
		assert.equal(outcome.ok, false);
		assert.match(outcome.error ?? "", /UI channel is unavailable/);
	});

	it("uses the reserved status key for upward messages without triggering a parent turn itself", async () => {
		const r = registry(true);
		const status: Array<{ key: string; value: string | undefined }> = [];
		const router = new MessageRouter({ sendMessage: () => {} } as Pick<ExtensionAPI, "sendMessage">, r, () => ({
			setStatus: (key, value) => {
				status.push({ key, value });
			},
		}));
		assert.deepEqual(await router.route({ from: "chi", to: "@parent", message: "Ready" }, true), {
			ok: true,
			verb: "sent",
		});
		assert.equal(status.length, 1);
		assert.equal(status[0]?.key, MSG_STATUS_KEY);
		assert.equal(JSON.parse(status[0]?.value ?? "{}").message, "Ready");
	});

	it("queues progress while the parent is active instead of starting a model turn", async () => {
		const r = registry();
		r.register(child());
		const sent: unknown[] = [];
		const router = new MessageRouter(
			{
				sendMessage(message: unknown) {
					sent.push(message);
				},
			} as Pick<ExtensionAPI, "sendMessage">,
			r,
			() => undefined,
		);
		assert.deepEqual(await router.route({ from: "bria", to: "@parent", message: "Progress" }, false), {
			ok: true,
			verb: "delivered",
		});
		assert.equal(sent.length, 0);
		const pending = r.takePendingForToolResult();
		assert.equal(pending.messages.length, 1);
		assert.equal(pending.messages[0]?.message, "Progress");
	});

	it("delivers idle-parent progress once through Pi's steer surface", async () => {
		const r = registry();
		r.register(child());
		r.parentBecameIdle();
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const router = new MessageRouter(
			{
				sendMessage(message: unknown, options: unknown) {
					sent.push({ message, options });
				},
			} as ExtensionAPI,
			r,
			() => undefined,
		);
		assert.deepEqual(await router.route({ from: "bria", to: "@parent", message: "Done" }, false), {
			ok: true,
			verb: "delivered",
		});
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	});
});

describe("extracted control tools", () => {
	it("registers ask_parent only for child agents", () => {
		assert.deepEqual([...harness().registered.keys()], ["agent_stop", "agent_send"]);
		assert.deepEqual([...harness(true).registered.keys()], ["agent_stop", "agent_send", "ask_parent"]);
	});

	it("normalizes stop IDs, closes tree state, and retires recovery only on successful stop", async () => {
		const h = harness();
		const agent = child();
		h.workerRegistry.register(agent);
		const result = await h.run("agent_stop", { agent_id: "@bria" });
		assert.equal(result.details.agentId, "bria");
		assert.equal(result.isError, undefined);
		assert.deepEqual(h.removed, ["bria"]);
		assert.deepEqual(h.retired, ["bria"]);
		const repeated = await h.run("agent_stop", { agent_id: "@bria" });
		assert.equal(repeated.isError, true);
		assert.deepEqual(h.removed, ["bria"]);
	});

	it("rejects instructions to a waiting child and allows the explicit answer", async () => {
		const h = harness();
		h.workerRegistry.register(child("chi", true));
		const invalid = await h.run("agent_send", { to: "@chi", message: "Continue" });
		assert.equal(invalid.isError, true);
		assert.equal(h.routed.length, 0);
		const answer = await h.run("agent_send", { to: "@chi", message: "Use option B", kind: "answer" });
		assert.equal(answer.isError, undefined);
		assert.equal(h.routed.length, 1);
		assert.equal(h.routed[0]?.answer, true);
		assert.equal((h.routed[0]?.message as { to: string } | undefined)?.to, "chi");
	});

	it("requires diagnostic evidence and suppresses duplicate diagnostic steering", async () => {
		const h = harness();
		h.workerRegistry.register(child());
		const tooShort = await h.run("agent_send", {
			to: "bria",
			message: "Found issue",
			kind: "diagnostic",
			evidence: "not enough",
		});
		assert.equal(tooShort.isError, true);
		assert.equal(h.routed.length, 0);
		const payload = {
			to: "bria",
			message: "Found issue",
			kind: "diagnostic",
			evidence: "file.ts:48, reproducible test case",
		};
		assert.equal((await h.run("agent_send", payload)).isError, undefined);
		const repeated = await h.run("agent_send", payload);
		assert.equal(repeated.details.suppressedDuplicate, true);
		assert.equal(h.routed.length, 1);
	});

	it("publishes an ask_parent question under the reserved status key", async () => {
		const h = harness(true);
		const result = await h.run("ask_parent", {
			question: "Which schema?",
			context: "Both APIs are available",
		});
		assert.equal(result.details.waitingForParent, true);
		assert.equal(h.statuses[0]?.key, QUESTION_STATUS_KEY);
		assert.equal(JSON.parse(h.statuses[0]?.value ?? "{}").from, "root-child");
		assert.equal(JSON.parse(h.statuses[0]?.value ?? "{}").question, "Which schema?");
	});
});
