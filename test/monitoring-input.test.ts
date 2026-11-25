import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type MonitoringPorts, registerMonitoringTools } from "../monitoring-tools.js";
import { AgentRegistry, type RegisteredAgent } from "../registry.js";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};
type ToolContext = {
	mode: string;
	ui: ExtensionUIContext;
	sessionManager: { getSessionId: () => string };
	hasPendingMessages: () => boolean;
	hasPendingUserInput?: () => boolean;
};
type RegisteredTool = {
	name: string;
	execute(
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((value: unknown) => void) | undefined,
		ctx: ToolContext,
	): Promise<ToolResult>;
};
type EventHandler = (event: Record<string, unknown>, ctx: ToolContext) => void;

function context(sessionId: string, hasPending = false, hasPendingUserInput?: boolean): ToolContext {
	return {
		mode: "rpc",
		ui: {} as ExtensionUIContext,
		sessionManager: { getSessionId: () => sessionId },
		hasPendingMessages: () => hasPending,
		...(hasPendingUserInput === undefined ? {} : { hasPendingUserInput: () => hasPendingUserInput }),
	};
}

function harness(t: TestContext) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, EventHandler[]>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const registry = new AgentRegistry({ notify: () => {}, supervisionIntervalMs: 0 });
	t.after(() => registry.shutdown());
	let transcriptReads = 0;
	const transcriptRequests: Array<{ detail?: "recent" | "full"; maxMessages: number; newestFirst?: boolean }> = [];
	const ports: MonitoringPorts = {
		registry,
		captureUi: () => {},
		unreadTranscript: async (_agent, options, newestFirst) => {
			transcriptReads++;
			transcriptRequests.push({ detail: options.detail, maxMessages: options.maxMessages, newestFirst });
			return { text: "", source: "none", returnedMessages: 0, remainingMessages: 0, hasMore: false };
		},
		activitySummary: () => "working",
		toErrorResult: (error) => ({
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			details: {},
			isError: true,
		}),
		hasParent: false,
	};
	registerMonitoringTools(pi, ports);

	function emit(event: string, data: Record<string, unknown>, sessionId = "parent-a") {
		for (const handler of handlers.get(event) ?? []) handler(data, context(sessionId));
	}
	return {
		registry,
		handlers,
		transcriptRequests,
		inspect(params: Record<string, unknown> = {}) {
			const tool = tools.get("agent_inspect");
			assert.ok(tool);
			return tool.execute("inspect-1", { agent_id: "bria", ...params }, undefined, undefined, context("parent-a"));
		},
		get transcriptReads() {
			return transcriptReads;
		},
		child(agentId = "bria", persistent = true) {
			let stopCalls = 0;
			const agent: RegisteredAgent = {
				agentId,
				label: "Implementer",
				status: "running",
				awaitingParent: false,
				stoppedByControl: false,
				persistent,
				stop: async () => {
					stopCalls++;
				},
				markStopped() {},
				sendMessage: async () => true,
			};
			registry.register(agent);
			return {
				agent,
				get stopCalls() {
					return stopCalls;
				},
			};
		},
		run(
			options: {
				agentId?: string;
				sessionId?: string;
				signal?: AbortSignal;
				timeoutSeconds?: number;
				hasPending?: boolean;
				hasPendingUserInput?: boolean;
				onUpdate?: () => void;
			} = {},
		) {
			const tool = tools.get("agent_wait");
			assert.ok(tool);
			return tool.execute(
				"wait-1",
				{ agent_id: options.agentId ?? "bria", timeout_seconds: options.timeoutSeconds ?? 30 },
				options.signal,
				options.onUpdate,
				context(options.sessionId ?? "parent-a", options.hasPending, options.hasPendingUserInput),
			);
		},
		emit,
		input(data: Record<string, unknown> = {}, sessionId = "parent-a") {
			emit("input_queued", { mode: "steer", source: "rpc", messageId: "input-1", ...data }, sessionId);
		},
		complete(agent: RegisteredAgent, output = "Child result") {
			agent.status = "completed";
			return registry.complete(agent, {
				status: "completed",
				output,
				stats: { tokens: 0, toolUses: 0, durationMs: 1 },
			});
		},
	};
}

async function assertPending(promise: Promise<unknown>) {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await setImmediate();
	assert.equal(settled, false, "wait must remain active");
}

describe("agent_wait user input", () => {
	it("releases a new wait immediately when user input is already queued", async (t) => {
		const h = harness(t);
		const child = h.child();
		const parent = new AbortController();
		const result = await h.run({ hasPending: true, signal: parent.signal, timeoutSeconds: 1 });
		assert.equal(result.details.interruptedByUser, true);
		assert.equal(parent.signal.aborted, false);
		assert.equal(child.stopCalls, 0);
		assert.equal(getEventListeners(parent.signal, "abort").length, 0);
		const next = h.run({ signal: parent.signal });
		await assertPending(next);
		await h.complete(child.agent);
		assert.equal((await next).content[0]?.text, "Child result");
	});

	it("does not label already queued background notifications as user input", async (t) => {
		const h = harness(t);
		const child = h.child();
		const pending = h.run({ hasPending: true, hasPendingUserInput: false });
		await assertPending(pending);
		await h.complete(child.agent);
		const result = await pending;
		assert.equal(result.details.interruptedByUser, undefined);
		assert.equal(result.content[0]?.text, "Child result");
	});

	it("releases for an accepted user input reported by the precise queue query", async (t) => {
		const h = harness(t);
		const child = h.child();
		const result = await h.run({ hasPending: true, hasPendingUserInput: true });
		assert.equal(result.details.interruptedByUser, true);
		assert.equal(child.stopCalls, 0);
	});

	for (const source of ["rpc", "interactive"]) {
		it(`releases an active wait on accepted ${source} steering without stopping the parent or child`, async (t) => {
			const h = harness(t);
			const child = h.child();
			const parent = new AbortController();
			const pending = h.run({ signal: parent.signal });
			assert.equal(getEventListeners(parent.signal, "abort").length, 1);
			h.input({ source, message: "USER_MESSAGE_DELIVERED_BY_PI" });
			h.input({ source }); // A repeated notification cannot complete the same wait twice.
			const result = await pending;
			assert.equal(result.isError, undefined);
			assert.deepEqual(result.details, { agentId: "bria", state: "running", interruptedByUser: true });
			assert.match(result.content[0]?.text ?? "", /new user input arrived/);
			assert.match(result.content[0]?.text ?? "", /child agents continue in the background/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /USER_MESSAGE_DELIVERED_BY_PI/);
			assert.equal(parent.signal.aborted, false);
			assert.equal(child.stopCalls, 0);
			assert.equal(child.agent.status, "running");
			assert.equal(h.registry.lookup("bria"), child.agent);
			assert.equal(h.transcriptReads, 0);
			assert.equal(getEventListeners(parent.signal, "abort").length, 0);

			h.input(); // An event without an active wait must not linger.
			const next = h.run({ signal: parent.signal });
			await assertPending(next);
			await h.complete(child.agent);
			assert.equal((await next).content[0]?.text, "Child result");
			assert.equal(getEventListeners(parent.signal, "abort").length, 0);
		});
	}

	it("wakes for accepted follow-ups as well as steering without stopping the child", async (t) => {
		const h = harness(t);
		const child = h.child();
		const pending = h.run();
		h.input({ mode: "followUp", source: "rpc" });
		const result = await pending;
		assert.equal(result.details.interruptedByUser, true);
		assert.equal(child.stopCalls, 0);
		assert.equal(child.agent.status, "running");
	});

	it("ignores generated input, other sessions, and events before input acceptance", async (t) => {
		const h = harness(t);
		const child = h.child();
		const pending = h.run();
		h.input({ mode: "followUp", source: "extension" });
		h.input({ source: "extension" });
		h.input({}, "parent-b");
		h.emit("input", { source: "rpc", text: "not yet accepted" });
		h.emit("input_rejected", { source: "rpc", mode: "steer" });
		h.emit("pending_message_deleted", { messageId: "cancelled" });
		await assertPending(pending);
		await h.complete(child.agent);
		const result = await pending;
		assert.equal(result.content[0]?.text, "Child result");
		assert.equal(result.details.interruptedByUser, undefined);
	});

	it("registers before the first progress callback, closing the wait-registration race", async (t) => {
		const h = harness(t);
		const child = h.child();
		const result = await h.run({ onUpdate: () => h.input() });
		assert.equal(result.isError, undefined);
		assert.equal(result.details.interruptedByUser, true);
		assert.equal(child.stopCalls, 0);
		const next = h.run();
		await assertPending(next);
		await h.complete(child.agent);
		assert.equal((await next).content[0]?.text, "Child result");
	});

	it("preserves explicit parent cancellation, including an already aborted or concurrent signal", async (t) => {
		for (const phase of ["before", "during", "after-input"]) {
			const h = harness(t);
			const child = h.child();
			const parent = new AbortController();
			if (phase === "before") parent.abort();
			const pending = h.run({ signal: parent.signal });
			if (phase === "after-input") h.input();
			if (phase !== "before") parent.abort();
			const result = await pending;
			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.text, "agent_wait cancelled");
			assert.equal(result.details.interruptedByUser, undefined);
			assert.equal(child.stopCalls, 0);
			assert.equal(getEventListeners(parent.signal, "abort").length, 0);
		}
	});

	it("keeps a completion that won the race and does not interrupt a later wait", async (t) => {
		const h = harness(t);
		const child = h.child();
		const pending = h.run();
		const completed = h.complete(child.agent);
		h.input();
		const result = await pending;
		await completed;
		assert.equal(result.content[0]?.text, "Child result");
		assert.equal(result.details.interruptedByUser, undefined);
		const nextChild = h.child("cora");
		const next = h.run({ agentId: "cora" });
		await assertPending(next);
		await h.complete(nextChild.agent, "Next child result");
		assert.equal((await next).content[0]?.text, "Next child result");
	});

	it("preserves a child completion that arrives after user input wins the race", async (t) => {
		const h = harness(t);
		const child = h.child();
		const pending = h.run();
		h.input();
		await h.complete(child.agent, "Result after interruption");
		const result = await pending;
		assert.equal(result.isError, undefined);
		assert.equal(result.details.interruptedByUser, true);
		assert.equal(result.details.state, "idle");
		assert.equal(child.stopCalls, 0);
		const cached = await h.run();
		assert.equal(cached.content[0]?.text, "Result after interruption");
		assert.equal(cached.details.interruptedByUser, undefined);
	});

	it("wakes every active wait in the same session while leaving another session alone", async (t) => {
		const h = harness(t);
		const a = h.child("bria");
		const b = h.child("cora");
		const c = h.child("dara");
		const first = h.run({ agentId: "bria" });
		const second = h.run({ agentId: "cora" });
		const other = h.run({ agentId: "dara", sessionId: "parent-b" });
		h.input();
		for (const result of await Promise.all([first, second])) {
			assert.equal(result.isError, undefined);
			assert.equal(result.details.interruptedByUser, true);
		}
		await assertPending(other);
		assert.equal(a.stopCalls + b.stopCalls + c.stopCalls, 0);
		await h.complete(c.agent);
		assert.equal((await other).content[0]?.text, "Child result");
	});

	it("cleans up after timeout, unknown child, and progress callback failure", async (t) => {
		const h = harness(t);
		h.child();
		const parent = new AbortController();
		const snapshot = await h.run({ signal: parent.signal, timeoutSeconds: 0 });
		assert.equal(snapshot.details.timedOut, false);
		assert.equal(getEventListeners(parent.signal, "abort").length, 0);
		const unknown = await h.run({ signal: parent.signal, agentId: "missing" });
		assert.equal(unknown.isError, true);
		assert.equal(getEventListeners(parent.signal, "abort").length, 0);
		const failedUpdate = await h.run({
			signal: parent.signal,
			onUpdate: () => {
				throw new Error("progress callback failed");
			},
		});
		assert.equal(failedUpdate.content[0]?.text, "progress callback failed");
		assert.equal(getEventListeners(parent.signal, "abort").length, 0);
		h.input();
		const next = h.run({ signal: parent.signal });
		await assertPending(next);
		parent.abort();
		assert.equal((await next).isError, true);
		assert.equal(getEventListeners(parent.signal, "abort").length, 0);
	});

	it("continues normal waits when the host never emits the optional input hook", async (t) => {
		const h = harness(t);
		const child = h.child();
		const pending = h.run();
		await assertPending(pending);
		await h.complete(child.agent);
		assert.equal((await pending).content[0]?.text, "Child result");
	});
});

describe("compact parent monitoring", () => {
	it("wait snapshots do not read transcripts; inspect requests recent evidence by default", async (t) => {
		const h = harness(t);
		const { agent } = h.child();
		agent.getMonitoringProgress = () => ({
			tools: 3,
			errors: 1,
			lastError: "specific failure",
			editedFiles: ["src/a.ts"],
			remainingFiles: 0,
			totalFiles: 1,
			shellCalls: 0,
		});
		const wait = await h.run({ timeoutSeconds: 0 });
		assert.match(wait.content[0]?.text ?? "", /src\/a\.ts/);
		assert.match(wait.content[0]?.text ?? "", /specific failure/);
		assert.equal(h.transcriptReads, 0);
		const recent = await h.inspect();
		assert.match(recent.content[0]?.text ?? "", /src\/a\.ts/);
		assert.deepEqual(h.transcriptRequests[0], { detail: "recent", maxMessages: 8, newestFirst: true });
		await h.inspect({ mode: "full" });
		assert.deepEqual(h.transcriptRequests[1], { detail: "full", maxMessages: 12, newestFirst: false });
	});
});

describe("inspection does not acknowledge unseen completion", () => {
	for (const resident of [false, true]) {
		it(`keeps ${resident ? "resident" : "archived"} recent previews compact and preserves delivery`, async (t) => {
			const h = harness(t);
			const { agent } = h.child("bria", resident);
			const output = "RESULT " + "evidence ".repeat(2000) + " END";
			await h.complete(agent, output);
			assert.equal(Boolean(h.registry.lookup("bria")), resident);
			const preview = await h.inspect();
			assert.ok((preview.content[0]?.text.length ?? 0) <= 2200);
			assert.ok(h.registry.peekSettlement("bria"), "preview must not consume settlement");
			const delivered = await h.run({ timeoutSeconds: 0 });
			assert.equal(delivered.details.alreadyDelivered, undefined);
			assert.match(delivered.content[0]?.text ?? "", /RESULT/);
			assert.equal(delivered.details.taskOutcome, "not_assessed");
			const again = await h.run({ timeoutSeconds: 0 });
			assert.doesNotMatch(again.content[0]?.text ?? "", /RESULT|evidence/);
		});
	}
});

it("inspection and diagnostics do not consume edited-file deltas", async (t) => {
	const h = harness(t);
	const { agent } = h.child();
	let consumed = false;
	agent.getMonitoringProgress = (consume = true) => {
		const editedFiles = consumed ? [] : ["src/changed.ts"];
		if (consume) consumed = true;
		return { tools: 1, errors: 0, editedFiles, remainingFiles: 0, totalFiles: 1, shellCalls: 1 };
	};
	await h.inspect({ mode: "diagnostics" });
	assert.equal(consumed, false);
	await h.inspect();
	assert.equal(consumed, false);
	const wait = await h.run({ timeoutSeconds: 0 });
	assert.match(wait.content[0]?.text ?? "", /src\/changed.ts/);
	assert.match(wait.content[0]?.text ?? "", /Shell writes may be untracked/);
	assert.equal(consumed, true);
});

it("full archived inspection acknowledges only the whole final output", async (t) => {
	const h = harness(t);
	const { agent } = h.child("bria", false);
	await h.complete(agent, "Verified outcome");
	const full = await h.inspect({ mode: "full" });
	assert.match(full.content[0]?.text ?? "", /Verified outcome/);
	assert.equal(h.registry.peekSettlement("bria")?.deliveredInToolResult, true);
	const wait = await h.run({ timeoutSeconds: 0 });
	assert.equal(wait.details.alreadyDelivered, true);
});
