/**
 * Tests for AgentProcess semantics (agent-process.ts).
 *
 * The stateful transport (rpc-client.ts) is NOT tested — a fake client is
 * injected via the `createClient` seam so we can drive the state machine
 * deterministically: spawnAndSend → settle → completion,
 * hard abort, external stop, and failure paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentProcess, type AgentProcessOptions } from "../agent-process.js";
import type { AgentActivity, AgentEvent } from "../event-interpret.js";
import type { RpcClientOptions } from "../rpc-client.js";
import type { RenderEvent } from "../types.js";

/** Programmable fake standing in for RpcClient. */
class FakeClient {
	commands: Array<{ type: string; message?: string }> = [];
	endInputCalls = 0;
	killCalls = 0;
	exitCode: number | null = null;
	isClosed = false;
	/** argv captured at construction (--model/--tools/--session-dir). */
	args: string[] = [];
	/** env captured at construction (identity injection). */
	env: NodeJS.ProcessEnv | undefined;

	private onEvent?: (event: { type: string }) => void;
	private onExit?: () => void;
	private exitResolve!: (v: { code: number | null; signal: string | null }) => void;
	private exitPromise = new Promise<{ code: number | null; signal: string | null }>((r) => {
		this.exitResolve = r;
	});

	/** Simulated session stats returned by get_session_stats. */
	stats: { tokens: number; toolCalls: number } = { tokens: 100, toolCalls: 2 };
	/** Simulated preflight result. */
	promptOk = true;
	/** Simulated last assistant text. */
	lastText = "final answer";
	/** Simulated captured stderr (crash root cause). */
	stderrText = "";
	/** sessionFile/sessionId returned by get_state. */
	sessionFile = "/tmp/fake.jsonl";
	sessionId = "sess-1";

	constructor(options: RpcClientOptions) {
		this.onEvent = options.onEvent;
		this.onExit = options.onExit;
		this.args = options.args;
		this.env = options.env;
	}

	async sendCommand(command: { type: string; message?: string }) {
		this.commands.push(command);
		switch (command.type) {
			case "prompt":
				return this.promptOk
					? { type: "response", command: "prompt", success: true }
					: { type: "response", command: "prompt", success: false, error: "preflight failed" };
			case "get_state":
				return {
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionFile: this.sessionFile, sessionId: this.sessionId },
				};
			case "get_messages":
				return {
					type: "response",
					command: "get_messages",
					success: true,
					data: {
						messages: [
							{ role: "user", content: "task", timestamp: 1 },
							{
								role: "toolResult",
								toolName: "read",
								content: [{ type: "text", text: "body" }],
								isError: false,
								timestamp: 2,
							},
						],
					},
				};
			case "get_session_stats":
				return {
					type: "response",
					command: "get_session_stats",
					success: true,
					data: { tokens: { total: this.stats.tokens }, toolCalls: this.stats.toolCalls },
				};
			case "get_last_assistant_text":
				return {
					type: "response",
					command: "get_last_assistant_text",
					success: true,
					data: { text: this.lastText },
				};
			case "abort":
				return { type: "response", command: command.type, success: true };
			default:
				return { type: "response", command: command.type, success: true };
		}
	}

	emitSettled(): void {
		this.onEvent?.({ type: "agent_settled" });
	}

	emitEvent(event: {
		[key: string]: unknown;
		type: string;
		assistantMessageEvent?: {
			type: string;
			delta?: unknown;
			contentIndex?: unknown;
			id?: unknown;
			toolName?: unknown;
			toolCall?: { id?: unknown; name?: unknown; arguments?: unknown };
		};
		messages?: Array<{ role?: string; stopReason?: string; errorMessage?: unknown; content?: unknown[] }>;
		message?: {
			content?: Array<{
				type?: string;
				text?: unknown;
				thinking?: unknown;
				name?: unknown;
				arguments?: unknown;
				id?: unknown;
			}>;
		};
	}): void {
		this.onEvent?.(event as never);
	}

	emitExit(code: number): void {
		this.exitCode = code;
		this.isClosed = true;
		this.onExit?.();
		this.exitResolve({ code, signal: null });
	}

	endInput(): void {
		this.endInputCalls++;
		this.emitExit(0);
	}

	kill(): void {
		this.killCalls++;
	}

	waitForExit(): Promise<{ code: number | null; signal: string | null }> {
		return this.exitPromise;
	}
}

/** RenderEvent minus the fold timestamp (timestamps are asserted separately). */
function eventShape(event: RenderEvent): unknown {
	if (event.kind === "thinking") return { kind: "thinking" };
	if (event.kind === "tool")
		return { kind: "tool", name: event.name, args: event.args, ...(event.id === undefined ? {} : { id: event.id }) };
	return { kind: "text", text: event.text };
}

function makeAgent(options: Partial<AgentProcessOptions> & { cwd: string }): { agent: AgentProcess; fake: FakeClient } {
	let fake!: FakeClient;
	const agent = new AgentProcess(
		{ ...options, agentId: options.agentId ?? "a1", label: options.label ?? "test agent" },
		{
			createClient: (opts: RpcClientOptions) => {
				fake = new FakeClient(opts);
				return fake as never;
			},
		},
	);
	return { agent, fake };
}

describe("AgentProcess — spawnAndSend", () => {
	it("moves to running and captures session info on prompt ack", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", label: "my task" });
		const started = await agent.spawnAndSend("do it");
		assert.deepEqual(started, { ok: true });
		assert.equal(agent.status, "running");
		assert.equal(agent.sessionPath, "/tmp/fake.jsonl");
		assert.equal(agent.sessionId, "sess-1");
		assert.ok(agent.agentId.length > 0);
		// prompt + get_state commands were sent
		assert.deepEqual(
			fake.commands.map((c) => c.type),
			["prompt", "get_state"],
		);
	});

	it("fails with the preflight error and stays failed", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptOk = false;
		const started = await agent.spawnAndSend("do it");
		assert.deepEqual(started, { ok: false, error: "preflight failed" });
		assert.equal(agent.status, "failed");
	});

	it("passes resolved runtime config and role prompt, never a tool allowlist", () => {
		const { fake } = makeAgent({
			cwd: "/tmp",
			model: "google/gemini-x",
			appendSystemPrompt: "You are the implementer.",
			label: "implementer",
			sessionDir: "/home/u/.pi/agent/subagent-sessions",
		});
		assert.deepEqual(fake.args, [
			"--model",
			"google/gemini-x",
			"--append-system-prompt",
			"You are the implementer.",
			"--name",
			"implementer",
			"--session-dir",
			"/home/u/.pi/agent/subagent-sessions",
		]);
	});

	it("passes thinking level through as --thinking", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", label: "explore", thinking: "high" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--thinking", "high", "--name", "explore"]);
	});

	it("omits --thinking when no level is given (inherit main session)", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", label: "explore" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--name", "explore"]);
	});
});

describe("AgentProcess — waitForCompletion", () => {
	it("completes after the first settle", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
		assert.equal(completion.output, "final answer");
		assert.equal(completion.stats.tokens, 100);
		assert.equal(completion.stats.toolUses, 2);
		assert.ok(completion.stats.durationMs >= 0);
		assert.equal(completion.sessionPath, "/tmp/fake.jsonl");
	});

	it("has no hidden task deadline", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		// No settle: the wait stays pending until the child itself settles or is explicitly stopped.
		let resolved = false;
		const completionPromise = agent.waitForCompletion().then((c) => {
			resolved = true;
			return c;
		});
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(resolved, false, "no deadline → no automatic stop");
		assert.ok(!fake.commands.some((c) => c.type === "abort"), "no abort was sent");

		fake.emitSettled();
		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
	});

	it("marks failed when the child exits non-zero without settling", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1); // crash — no settle, onExit releases waiters

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
	});

	it("surfaces captured stderr as the output when a failed child left no text", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = ""; // no assistant output before the crash
		fake.stderrText = "FATAL: bad API key";

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1);

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "FATAL: bad API key");
	});
});

describe("AgentProcess — onDelta", () => {
	it("streams text_delta events from message_update", async () => {
		const deltas: string[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onDelta: (d) => deltas.push(d) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello " },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "World" },
		});
		fake.emitEvent({ type: "agent_settled" });

		assert.deepEqual(deltas, ["Hello ", "World"]);
	});

	it("ignores non-delta message updates", async () => {
		const deltas: string[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onDelta: (d) => deltas.push(d) });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
		assert.deepEqual(deltas, []);
	});
});

describe("AgentProcess — agent API errors", () => {
	it("marks failed with the API error when agent_end reports stopReason error", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = ""; // error turn produces no assistant text

		const completionPromise = agent.waitForCompletion();
		fake.emitEvent({
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limited" },
			],
		});
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "429 Rate limited");
	});

	it("stays completed when agent_end has no error stop reason", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
		});
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
	});
});

describe("AgentProcess — transcript", () => {
	it("reads live messages through Pi RPC get_messages", async () => {
		const { agent } = makeAgent({ cwd: "/tmp", label: "inspect" });
		const messages = await agent.getMessages();
		assert.equal(messages.length, 2);
		assert.deepEqual((messages[0] as { role?: string }).role, "user");
		assert.deepEqual((messages[1] as { role?: string }).role, "toolResult");
	});
});

describe("AgentProcess — latest activity", () => {
	it("tracks streamed text as the latest activity", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Found 5 files" },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "text", text: "Found 5 files" });
	});

	it("tracks thinking while the agent is reasoning", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "Let me analyze the structure" },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "thinking", text: "" });
	});

	it("summarizes tool calls with the friendly argument key", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { name: "bash", arguments: { command: "sleep 20" } },
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", name: "bash", args: "sleep 20" });
	});

	it("summarizes tool calls with JSON when no friendly key exists", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { name: "custom_tool", arguments: { foo: 1 } },
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", name: "custom_tool", args: '{"foo":1}' });
	});

	it("returns undefined before any message_update", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		assert.equal(agent.getLatestActivity(), undefined);
	});

	it("fires onActivityChange for thinking and tool transitions", async () => {
		const events: AgentActivity[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onActivityChange: (a) => events.push(a) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "analyzing…" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		});

		assert.deepEqual(events, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "bash", args: "ls" },
		]);
	});

	it("records every tool call and collapses consecutive thinking", async () => {
		const events: AgentActivity[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", onActivityChange: (a) => events.push(a) });

		// Two thinking_delta deltas → one thinking marker (dedup).
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "one" } });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "two" } });
		// Two bash calls → two tool rows, both recorded.
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "read", arguments: { path: "a.ts" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "read", arguments: { path: "b.ts" } } },
		});

		assert.deepEqual(events, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "read", args: "a.ts" },
			{ kind: "tool", name: "read", args: "b.ts" },
		]);
		assert.deepEqual(
			agent.getEvents().map((e) => e.kind),
			["thinking", "tool", "tool"],
		);
	});

	it("accumulates thinking, tool, and text events in order", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const starter = agent.spawnAndSend("prompt");
		fake.emitEvent({ type: "agent_settled" }); // acks spawn
		await starter;

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " world" },
		});

		assert.deepEqual(agent.getEvents().map(eventShape), [
			{ kind: "thinking" },
			{ kind: "tool", name: "bash", args: "ls" },
			{ kind: "text", text: "hello world" },
		]);
	});

	it("records each toolcall_end as its own tool event", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const starter = agent.spawnAndSend("prompt");
		fake.emitEvent({ type: "agent_settled" }); // acks spawn
		await starter;

		// Each tool call arrives as one authoritative toolcall_end (v0.84 — no
		// incremental snapshots to merge anymore); text deltas interleave.
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			},
		});
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call_2", name: "read", arguments: { path: "a.ts" } },
			},
		});
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y" } });

		assert.deepEqual(agent.getEvents().map(eventShape), [
			{ kind: "tool", name: "bash", args: "echo hi", id: "call_1" },
			{ kind: "text", text: "x" },
			{ kind: "tool", name: "read", args: "a.ts", id: "call_2" },
			{ kind: "text", text: "y" },
		]);
	});
});

describe("AgentProcess — persistent / in-tree messages", () => {
	it("persistent flags through to the process", () => {
		const { agent } = makeAgent({ cwd: "/tmp", persistent: true });
		assert.equal(agent.persistent, true);
		const { agent: plain } = makeAgent({ cwd: "/tmp" });
		assert.equal(plain.persistent, false);
	});

	it("sendMessage delivers a prompt with streamingBehavior steer (unified delivery)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const ok = await agent.sendMessage("[from ] focus on errors");
		assert.equal(ok, true);
		const last = fake.commands[fake.commands.length - 1];
		assert.equal(last?.type, "prompt");
		assert.equal((last as { streamingBehavior?: string })?.streamingBehavior, "steer");
		assert.equal((last as { message?: string })?.message, "[from ] focus on errors");
	});

	it("sendMessage returns false on a failed preflight", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptOk = false;
		assert.equal(await agent.sendMessage("hi"), false);
	});

	it("sendMessage wakes an idle persistent agent back to running", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done; // → completed, process kept (persistent)
		assert.equal(agent.status, "completed");
		assert.equal(await agent.sendMessage("continue"), true);
		assert.equal(agent.status, "running");
	});

	it("a woken agent streams its follow-up output (issue #30: the widget excerpt must move)", async () => {
		const deltas: string[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true, onDelta: (d) => deltas.push(d) });
		await agent.spawnAndSend("count to 3");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;

		// No deltas for the first turn: everything asserted below came from the wake.
		await agent.sendMessage("count to 5");
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "1 2 3" } });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " 4 5" } });

		assert.deepEqual(deltas, ["1 2 3", " 4 5"], "唤醒轮的增量必须送出来");
		assert.deepEqual(agent.getLatestActivity(), { kind: "text", text: "1 2 3 4 5" }, "摘要要跟上，widget 才有内容");
	});

	it("a settle after wake returns the persistent agent to completed (idle)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		await agent.sendMessage("continue");
		fake.emitSettled();
		assert.equal(agent.status, "completed");
	});

	it("onIdle fires with completed when a woken persistent agent settles", async () => {
		const outcomes: string[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true, onIdle: (o) => outcomes.push(o) });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		assert.deepEqual(outcomes, [], "no onIdle before a wake");
		await agent.sendMessage("continue");
		fake.emitSettled();
		assert.deepEqual(outcomes, ["completed"], "completed on a clean follow-up settle");
	});

	it("a failed follow-up reports failed — never disguised as idle", async () => {
		const outcomes: string[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true, onIdle: (o) => outcomes.push(o) });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		await agent.sendMessage("continue");
		// agent_end with a model error → agentError set → the follow-up failed.
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "API boom" }],
		} as never);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["failed"]);
		assert.equal(agent.status, "failed");
	});

	it("ask_parent marks the child waiting and preserves it for an answer", async () => {
		const questions: string[] = [];
		const { agent, fake } = makeAgent({
			cwd: "/tmp",
			onQuestion: (question) => questions.push(question.question),
		});
		await agent.spawnAndSend("work");
		fake.emitEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "pi-subagent-question",
			statusText: JSON.stringify({ from: agent.agentId, question: "Which behavior?" }),
		});
		const completionPromise = agent.waitForCompletion();
		fake.emitSettled();
		await completionPromise;
		assert.equal(agent.awaitingParent, true);
		assert.equal(agent.shouldStayResident, true);
		assert.equal(agent.pendingQuestion?.question, "Which behavior?");
		assert.deepEqual(questions, ["Which behavior?"]);
	});

	it("a successful parent answer resumes the same waiting context", async () => {
		const idle: string[] = [];
		const { agent, fake } = makeAgent({
			cwd: "/tmp",
			onIdle: (outcome) => idle.push(outcome),
		});
		await agent.spawnAndSend("work");
		fake.emitEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "pi-subagent-question",
			statusText: JSON.stringify({ from: agent.agentId, question: "Need answer" }),
		});
		const first = agent.waitForCompletion();
		fake.emitSettled();
		await first;
		assert.equal(agent.awaitingParent, true);

		assert.equal(await agent.sendMessage("Use behavior A."), true);
		assert.equal(agent.awaitingParent, false);
		assert.equal(agent.pendingQuestion, undefined);
		assert.equal(agent.status, "running");
		fake.emitSettled();
		assert.deepEqual(idle, ["completed"]);
	});

	it("in-tree messages from the child fire onMessage", () => {
		const received: Array<{ to: string; from: string; message: string }> = [];
		const { fake } = makeAgent({ cwd: "/tmp", onMessage: (m) => received.push(m) });
		fake.emitEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "pi-subagent-msg",
			statusText: JSON.stringify({ to: "@parent", from: "a1", message: "need help" }),
		} as never);
		assert.deepEqual(received, [{ to: "@parent", from: "a1", message: "need help" }]);
	});

	it("identity env is passed to the child", () => {
		const { fake } = makeAgent({ cwd: "/tmp", env: { PI_SUBAGENT_AGENT_ID: "a1", PI_SUBAGENT_PARENT: "" } });
		assert.ok(fake.env);
		assert.equal(fake.env.PI_SUBAGENT_AGENT_ID, "a1");
	});
});

describe("AgentProcess — stop", () => {
	it("graceful stop flags stoppedByControl and ends stdin", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		await agent.stop();
		assert.equal(agent.status, "stopped");
		assert.equal(agent.stoppedByControl, true);
		assert.equal(fake.endInputCalls, 1);
	});

	it("interrupts a pending waitForCompletion with status stopped", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		await agent.stop(); // endInput → fake exits → onExit releases settle

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
	});
});

describe("AgentProcess — onStream sink (events.jsonl tail)", () => {
	it("fires for thinking/text/tool_start/tool_call in wire order, fold unchanged", () => {
		const streamed: AgentEvent[] = [];
		const deltas: string[] = [];
		const activities: AgentActivity[] = [];
		const { agent, fake } = makeAgent({
			cwd: "/tmp",
			onStream: (e) => streamed.push(e),
			onDelta: (d) => deltas.push(d),
			onActivityChange: (a) => activities.push(a),
		});

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { name: "bash", arguments: { command: "ls" }, id: "call-1" },
			},
		});

		assert.deepEqual(streamed, [
			{ type: "thinking", text: "hmm", contentIndex: 0 },
			{ type: "text_delta", delta: "hi", contentIndex: 0 },
			{ type: "tool_start", toolCallId: "call-1", toolName: "bash", contentIndex: 1 },
			{
				type: "tool_call",
				activity: { kind: "tool", name: "bash", args: "ls", id: "call-1" },
				contentIndex: 1,
			},
		]);
		// The existing fold semantics and ordering are untouched by the sink.
		assert.deepEqual(
			agent.getEvents().map((e) => e.kind),
			["thinking", "text", "tool"],
		);
		assert.deepEqual(deltas, ["hi"]);
		assert.deepEqual(activities, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "bash", args: "ls", id: "call-1" },
		]);
	});

	it("fires with no card callbacks attached (background-like: sink is mode-independent)", () => {
		const streamed: AgentEvent[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onStream: (e) => streamed.push(e) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "bg thought" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "bg text" },
		});

		assert.deepEqual(streamed, [
			{ type: "thinking", text: "bg thought", contentIndex: 0 },
			{ type: "text_delta", delta: "bg text", contentIndex: 0 },
		]);
	});

	it("forwards the marker-only thinking; starts carry nothing new", () => {
		const streamed: AgentEvent[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onStream: (e) => streamed.push(e) });

		fake.emitEvent({ type: "agent_settled" });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });

		// The marker-only thinking (no text) still reaches the sink so the fold
		// and the tail observe the same event sequence; starts carry nothing.
		assert.deepEqual(streamed, [{ type: "thinking" }]);
	});
});

describe("AgentProcess — markStopped (explicit-stop terminal marker)", () => {
	async function settledPersistent(): Promise<{ agent: AgentProcess }> {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done; // → completed, process resident (idle)
		assert.equal(agent.status, "completed");
		return { agent };
	}

	it("stop() alone leaves a settled persistent agent at completed (normal path)", async () => {
		const { agent } = await settledPersistent();
		await agent.stop(); // early return: child already gone
		assert.equal(agent.status, "completed", "stop() must not relabel completions");
	});

	it("markStopped flips a settled persistent agent to stopped", async () => {
		const { agent } = await settledPersistent();
		await agent.stop();
		agent.markStopped();
		assert.equal(agent.status, "stopped");
		assert.equal(agent.stoppedByControl, true, "explicit stop suppresses later notifications");
	});

	it("markStopped is idempotent", async () => {
		const { agent } = await settledPersistent();
		agent.markStopped();
		agent.markStopped();
		assert.equal(agent.status, "stopped");
	});

	it("markStopped keeps an already-terminal failed", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "API boom" }],
		} as never);
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		assert.equal(agent.status, "failed");
		agent.markStopped();
		assert.equal(agent.status, "failed", "failed is already terminal — not disguised");
	});
});

describe("AgentProcess — event timestamps", () => {
	it("stamps thinking, tool_call and text_delta folds with a fresh ts", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const before = Date.now();
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		const after = Date.now();
		const events = agent.getEvents();
		assert.equal(events.length, 3);
		for (const event of events) {
			assert.equal(typeof event.ts, "number");
			assert.ok(
				event.ts !== undefined && event.ts >= before && event.ts <= after,
				"ts is fresh (no clock assertions beyond monotonic-ish freshness)",
			);
		}
	});
});
