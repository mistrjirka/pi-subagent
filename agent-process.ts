/**
 * pi-subagent — AgentProcess.
 *
 * One resident `pi --mode rpc` child, wrapped behind Agent-tool semantics.
 * The parent extension holds N AgentProcess instances (foreground: one at a
 * time; background: several).
 *
 * Lifecycle:
 *   spawnAndSend(prompt) → running
 *   [ optional: steer(msg) / abort() while running ]
 *   waitForCompletion()  → terminal (completed / failed / stopped)
 *   stop()               → graceful stdin EOF, SIGTERM fallback
 *
 * Task limits: none. The child runs until it finishes, fails, its parent/user
 * explicitly stops it, or the hosting Pi process exits.
 */

import type { AgentTreeEvent } from "./event-interpret.js";
import { type AgentActivity, type AgentEvent, interpretEvent } from "./event-interpret.js";
import type { AgentMessage, AgentQuestion, RpcCommand, RpcEvent } from "./protocol.js";
import { RpcClient, type RpcClientOptions } from "./rpc-client.js";
import type { RenderEvent } from "./types.js";

type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

type TerminalStatus = Exclude<AgentStatus, "queued" | "running">;

interface AgentStats {
	tokens: number;
	outputTokens?: number;
	contextTokens?: number;
	toolUses: number;
	durationMs: number;
}

export interface AgentCompletion {
	/** Revision of the work that produced this snapshot. */
	generation?: number;
	status: TerminalStatus;
	output: string;
	stats: AgentStats;
	sessionPath?: string;
	sessionId?: string;
}

/** Append-ordered Pi session entries, optionally read after a stable entry id. */
export interface AgentSessionEntryPage {
	entries: unknown[];
	leafId: string | null;
}

export interface AgentProcessOptions {
	cwd: string;
	/** Resolved "provider/id" model string, or inherit when omitted. */
	model?: string;
	/** Reasoning intensity ("off"…"max"), passed as --thinking. */
	thinking?: string;
	/** Extra role guidance appended to Pi's normal system prompt. */
	appendSystemPrompt?: string;
	/** Short task label (notification card). */
	label: string;
	/** Short human-readable id ("max", "zoe") assigned by the registry (name-gen.ts). */
	agentId: string;
	/** Custom session storage dir (--session-dir) — keeps sub-agent sessions out of `pi -r`. */
	sessionDir?: string;
	/** Streamed assistant text deltas (rpc message_update/text_delta) — for live tool-card output. */
	onDelta?: (delta: string) => void;
	/** Thinking/tool activity transitions (no text delta involved) — for live tool-card rows. */
	onActivityChange?: (activity: AgentActivity) => void;
	/** Raw mapped stream records (thinking/text/tool_start/tool_call) — for the
	 *  append-only `events.jsonl` tail. Fires for BOTH spawn modes; onEvent is
	 *  mode-independent. Must never affect the fold below. */
	onStream?: (event: AgentEvent) => void;
	/** In-tree message received from this child (extension_ui_request under the reserved key). */
	onMessage?: (message: AgentMessage) => void;
	/** Structured ask_parent request from this child. */
	onQuestion?: (question: AgentQuestion) => void;
	/** Tree telemetry from this child's own spawns (extension_ui_request, tree key) — forward or apply. */
	onTreeEvent?: (event: AgentTreeEvent) => void;
	/** A woken persistent agent settled: "completed" → idle, "failed" → report + clean up. */
	onIdle?: (outcome: "completed" | "failed", generation: number) => void;
	/** Resident after completion (idle, zero token) — explicit opt-in, default off. */
	persistent?: boolean;
	/** Extra child environment (identity injection: PI_SUBAGENT_AGENT_ID / PI_SUBAGENT_PARENT). */
	env?: NodeJS.ProcessEnv;
}

interface AgentProcessDeps {
	/** Test seam: override client creation (defaults to a real RpcClient). */
	createClient?: (options: RpcClientOptions) => RpcClient;
}

const STOP_GRACE_MS = 5_000;
const STARTUP_PROMPT_TIMEOUT_MS = 60_000;

// No task-level limits live here. Explicit stop/host shutdown are the only
// framework lifecycle controls.

export class AgentProcess {
	readonly agentId: string;
	readonly label: string;
	readonly startedAt = Date.now();
	readonly model: string | undefined;
	readonly thinking: string | undefined;
	/** Resident after completion (idle, zero token) — explicit opt-in. */
	readonly persistent: boolean;
	/** True for explicit persistence or a child retained to complete an ask_parent round-trip. */
	get shouldStayResident(): boolean {
		return this.persistent || this.awaitingParent;
	}

	status: AgentStatus = "queued";

	/** True when stop() was called via agent_stop (deliberate user action → no notification). */
	stoppedByControl = false;
	/** Child has yielded after ask_parent and is waiting for the spawning agent to answer. */
	awaitingParent = false;
	pendingQuestion: AgentQuestion | undefined;
	/** Keeps a non-persistent child resident only for the ask_parent round-trip. */
	private questionResident = false;

	private readonly client: RpcClient;

	private settleWaiters = new Set<() => void>();
	/** Total agent_settled events seen; lets awaitSettled skip settles that
	 *  arrived while no waiter was attached (synchronous test emit pattern). */
	private settleCount = 0;
	/** settleCount observed at the last awaitSettled() call. */
	private lastSettledCount = 0;
	/** Process lifetime is independent of completed work revisions. */
	generation = 1;
	private closing = false;
	private stopPromise: Promise<void> | undefined;
	private messageQueue: Promise<void> = Promise.resolve();
	private lastSettlement: { status: TerminalStatus; generation: number } | undefined;
	/** Model API error captured from agent_end (stopReason "error"). */
	private agentError: string | null = null;
	/** Latest activity excerpt for the widget. */
	private latestActivity: AgentActivity | null = null;
	/** Ordered activity stream — accumulated from RPC events at the source. */
	private events: RenderEvent[] = [];

	sessionPath?: string;
	sessionId?: string;

	constructor(options: AgentProcessOptions, deps: AgentProcessDeps = {}) {
		this.agentId = options.agentId;
		this.label = options.label;
		this.model = options.model;
		this.thinking = options.thinking;
		this.persistent = options.persistent ?? false;
		this.onDelta = options.onDelta;
		this.onActivityChange = options.onActivityChange;
		this.onMessage = options.onMessage;
		this.onQuestion = options.onQuestion;
		this.onTreeEvent = options.onTreeEvent;
		this.onIdle = options.onIdle;
		this.onStream = options.onStream;

		const args: string[] = [];
		if (options.model) args.push("--model", options.model);
		if (options.thinking) args.push("--thinking", options.thinking);
		if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
		// Label names the session (--name, capped at 80 chars).
		args.push("--name", options.label.slice(0, 80));
		if (options.sessionDir) args.push("--session-dir", options.sessionDir);

		const clientOptions: RpcClientOptions = {
			args,
			cwd: options.cwd,
			env: options.env,
			onEvent: (event) => this.onEvent(event),
			onExit: () => {
				// Process died (any reason): release everyone waiting on settle.
				if (this.status === "running" || this.status === "queued")
					this.status = this.stoppedByControl ? "stopped" : "failed";
				this.lastSettlement = { status: this.status as TerminalStatus, generation: this.generation };
				this.settle();
			},
		};
		this.client = deps.createClient ? deps.createClient(clientOptions) : new RpcClient(clientOptions);
	}

	// ── Public API ─────────────────────────────────────────

	/** Spawn + send the prompt; resolves once the prompt preflight succeeded. */
	async spawnAndSend(prompt: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const response = await this.client
			.sendCommand({ type: "prompt", message: prompt }, STARTUP_PROMPT_TIMEOUT_MS)
			.catch((err: Error) => ({
				type: "response" as const,
				command: "prompt",
				success: false as const,
				error: err.message,
			}));

		if (!response.success) {
			this.status = "failed";
			return { ok: false, error: response.error };
		}

		// Best-effort session info for the notification / attach (issue #10).
		const data = await this.sendData<{ sessionFile?: string; sessionId?: string }>({ type: "get_state" });
		if (data) {
			this.sessionPath = data.sessionFile;
			this.sessionId = data.sessionId;
		}

		if (this.closing) return { ok: false, error: "Child stopped during startup." };
		if (this.status === "queued") this.status = "running";
		return { ok: true };
	}

	/** Hard-interrupt the current turn. */
	async abort(): Promise<void> {
		await this.client.sendCommand({ type: "abort" }).catch(() => {});
	}

	/**
	 * Deliver one in-tree message to this agent (parent→child): a prompt
	 * with streamingBehavior "steer" — idle starts a new turn (wake), a
	 * running child queues it (delivered after the turn). Resolves whether
	 * the prompt preflight accepted the message. Waking an idle persistent
	 * agent flips it back to running.
	 */
	sendMessage(text: string): Promise<boolean> {
		const result = this.messageQueue.then(() => this.deliverMessage(text));
		this.messageQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async deliverMessage(text: string): Promise<boolean> {
		if (this.closing || this.client.isClosed || this.status === "stopped" || this.status === "failed") return false;
		const previousStatus = this.status;
		const previousQuestion = this.pendingQuestion;
		const wasAwaitingParent = this.awaitingParent;
		const waking = previousStatus === "completed" || wasAwaitingParent;
		this.generation++;
		if (waking) {
			this.agentError = null;
			this.status = "running";
			this.awaitingParent = false;
			this.pendingQuestion = undefined;
			this.lastSettledCount = this.settleCount;
		}
		const generation = this.generation;
		const deliveredText = wasAwaitingParent ? `[parent answer to your pending ask_parent]\n${text}` : text;
		const response = await this.client
			.sendCommand({ type: "prompt", message: deliveredText, streamingBehavior: "steer" })
			.catch((err: Error) => ({ success: false, error: err.message }));
		if (this.closing || this.stoppedByControl) return false;
		if (!response.success) {
			if (waking && this.generation === generation && this.status === "running" && !this.pendingQuestion) {
				this.status = previousStatus;
				this.awaitingParent = wasAwaitingParent;
				this.pendingQuestion = previousQuestion;
				this.lastSettlement = { status: "completed", generation };
				// Recollect the unchanged idle turn under this revision: old in-flight
				// collectors were invalidated before the attempted wake.
				this.onIdle?.("completed", generation);
			}
			return false;
		}
		// A settle/new question can arrive before this acknowledgement. Do not
		// overwrite either state using the pre-await snapshot.
		return true;
	}

	/** Current final assistant text (rpc get_last_assistant_text). */
	async lastOutput(): Promise<string> {
		const data = await this.sendData<{ text?: string | null }>({ type: "get_last_assistant_text" });
		return data?.text ?? "";
	}

	/** Live child transcript messages from Pi RPC. Read-only; safe while the child is running.
	 * Unlike best-effort stats helpers, transcript failures are surfaced so monitoring
	 * can fall back explicitly instead of misreporting an RPC error as an empty transcript. */
	async getMessages(): Promise<unknown[]> {
		const response = await this.client.sendCommand({ type: "get_messages" });
		if (!response.success) throw new Error(`get_messages failed: ${response.error}`);
		const data = response.data as { messages?: unknown[] } | undefined;
		if (!data || !Array.isArray(data.messages)) throw new Error("get_messages returned no messages array");
		return data.messages;
	}

	/**
	 * Append-ordered session entries from Pi RPC. `since` is a stable entry id,
	 * so supervision can advance exactly instead of repeatedly slicing a tail.
	 */
	async getEntries(since?: string): Promise<AgentSessionEntryPage> {
		const response = await this.client.sendCommand({
			type: "get_entries",
			...(since ? { since } : {}),
		});
		if (!response.success) throw new Error(`get_entries failed: ${response.error}`);
		const data = response.data as { entries?: unknown[]; leafId?: unknown } | undefined;
		if (!data || !Array.isArray(data.entries)) throw new Error("get_entries returned no entries array");
		return {
			entries: data.entries,
			leafId: typeof data.leafId === "string" ? data.leafId : null,
		};
	}

	/** Best-effort token/tool stats from get_session_stats. */
	async getStats(): Promise<Omit<AgentStats, "durationMs"> | null> {
		const data = await this.sendData<{
			tokens?: { total?: number; output?: number };
			contextUsage?: { tokens?: number | null };
			toolCalls?: number;
		}>({
			type: "get_session_stats",
		});
		if (!data) return null;
		return {
			tokens: data.tokens?.total ?? 0,
			...(typeof data.tokens?.output === "number" ? { outputTokens: data.tokens.output } : {}),
			...(typeof data.contextUsage?.tokens === "number" ? { contextTokens: data.contextUsage.tokens } : {}),
			toolUses: data.toolCalls ?? 0,
		};
	}

	/** sendCommand → typed response payload (null on failure/timeout/empty). */
	private async sendData<T>(command: RpcCommand): Promise<T | null> {
		const response = await this.client.sendCommand(command).catch(() => null);
		if (!response?.success || !response.data) return null;
		return response.data as T;
	}

	/**
	 * Wait until the agent settles or is explicitly stopped/exits. There is no
	 * task deadline, turn cap, token cap, or tool-call cap in this runtime.
	 */
	async waitForCompletion(): Promise<AgentCompletion> {
		if ((this.status === "running" || this.status === "queued") && !this.client.isClosed) await this.awaitSettled();
		const settled = this.lastSettlement ?? {
			status: (this.status === "stopped"
				? "stopped"
				: this.agentError || this.client.exitCode
					? "failed"
					: "completed") as TerminalStatus,
			generation: this.generation,
		};
		return this.completionForTurn(settled.status, settled.generation);
	}

	/** Collect a revision-tagged snapshot; callers reject it if work resumed. */
	async completionForTurn(status: TerminalStatus, generation = this.generation): Promise<AgentCompletion> {
		const error = this.agentError;
		const [output, stats] = await Promise.all([this.lastOutput(), this.getStats()]);
		return {
			generation,
			status,
			output: output.trim() ? output : error || (status === "failed" ? this.client.stderrText : output),
			stats: {
				tokens: stats?.tokens ?? 0,
				...(stats?.outputTokens !== undefined ? { outputTokens: stats.outputTokens } : {}),
				...(stats?.contextTokens !== undefined ? { contextTokens: stats.contextTokens } : {}),
				toolUses: stats?.toolUses ?? 0,
				durationMs: Date.now() - this.startedAt,
			},
			sessionPath: this.sessionPath,
			sessionId: this.sessionId,
		};
	}

	/**
	 * Graceful stop: stdin EOF → pi rpc shutdown(). If the child doesn't
	 * exit within STOP_GRACE_MS, SIGTERM as a fallback. Flags the stop as
	 * user-controlled (agent_stop / cancel) — suppresses notifications.
	 */
	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.closing = true;
		if (this.status === "running" || this.status === "queued") {
			this.markStopped();
			this.lastSettlement = { status: "stopped", generation: this.generation };
			this.settle();
		}
		this.stopPromise = this.closeProcess();
		return this.stopPromise;
	}

	/** Record an explicit stop before asynchronous transport teardown. This
	 * invalidates older completion snapshots and releases parent-question state.
	 * A failed child retains its failure status. */
	markStopped(): void {
		this.stoppedByControl = true;
		this.generation++;
		this.awaitingParent = false;
		this.pendingQuestion = undefined;
		if (this.status === "stopped" || this.status === "failed") return;
		this.status = "stopped";
	}

	/** stdin EOF + SIGTERM fallback; waits for the child to exit. */
	private async closeProcess(): Promise<void> {
		this.client.endInput();
		if (this.client.isClosed) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.client.waitForExit(),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, STOP_GRACE_MS);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (!this.client.isClosed) {
			this.client.kill("SIGTERM");
			await Promise.race([
				this.client.waitForExit(),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, STOP_GRACE_MS);
				}),
			]);
			if (timer) clearTimeout(timer);
			if (!this.client.isClosed) this.client.kill("SIGKILL");
		}
	}

	/** Latest activity excerpt for the widget (undefined until the first message_update). */
	getLatestActivity(): AgentActivity | undefined {
		return this.latestActivity ?? undefined;
	}

	/**
	 * Ordered activity stream accumulated from every RPC event this agent
	 * processed. Thinking and tool-call activity are recorded as they arrive;
	 * text_delta events are folded into the current text event (consecutive
	 * deltas append). The stream mirrors pi's session replay order.
	 */
	getEvents(): RenderEvent[] {
		return this.events;
	}

	// ── Internal ───────────────────────────────────────────

	private readonly onDelta: ((delta: string) => void) | undefined;
	private readonly onActivityChange: ((activity: AgentActivity) => void) | undefined;
	private readonly onMessage: ((message: AgentMessage) => void) | undefined;
	private readonly onQuestion: ((question: AgentQuestion) => void) | undefined;
	private readonly onTreeEvent: ((event: AgentTreeEvent) => void) | undefined;
	private readonly onIdle: ((outcome: "completed" | "failed", generation: number) => void) | undefined;
	private readonly onStream: ((event: AgentEvent) => void) | undefined;

	private onEvent(event: RpcEvent): void {
		// Raw protocol shapes are interpreted in event-interpret.ts — the only
		// place pi's event vocabulary is mapped onto ours. Since v0.84.0 the
		// wire carries only assistantMessageEvent deltas, so each event maps to
		// a discrete marker here: the policy surface is settle bookkeeping,
		// thinking/tool activity push, streamed text folding, and in-tree
		// message delivery.
		for (const ev of interpretEvent(event)) {
			switch (ev.type) {
				case "settled": {
					const followUp = this.settleCount > 0;
					const outcome = this.agentError ? "failed" : "completed";
					if (!this.stoppedByControl && !this.closing) this.status = outcome;
					this.lastSettlement = {
						status: this.stoppedByControl ? "stopped" : outcome,
						generation: this.generation,
					};
					this.settle();
					if (followUp && (this.persistent || this.questionResident) && !this.stoppedByControl && !this.closing) {
						this.onIdle?.(outcome, this.generation);
					}
					break;
				}
				case "assistant_start":
				case "assistant_end":
					// Stream-only message boundaries. They give external transcript
					// readers a stable assistant-turn identity without changing the
					// card/widget activity fold.
					this.onStream?.(ev);
					break;
				case "thinking": {
					// Preserve plaintext reasoning deltas for the human-facing card/widget.
					// Consecutive chunks stay one event so the card grows in place rather
					// than adding one row per token.
					const chunk = ev.text ?? "";
					const last = this.events[this.events.length - 1];
					if (last?.kind === "thinking") {
						last.text = (last.text ?? "") + chunk;
					} else {
						this.events.push({ kind: "thinking", text: chunk, ts: Date.now() });
					}
					const activity: AgentActivity = {
						kind: "thinking",
						text: last?.kind === "thinking" ? (last.text ?? "") : chunk,
					};
					this.latestActivity = activity;
					this.onActivityChange?.(activity);
					this.onStream?.(ev);
					break;
				}
				case "tool_execution_start":
				case "tool_execution_end":
				case "tool_start":
					// Stream-only: the fold waits for toolcall_end (authoritative args).
					this.onStream?.(ev);
					break;
				case "tool_call": {
					// toolcall_end is the authoritative tool call: the wire streams
					// the name on toolcall_start and the arguments on toolcall_delta,
					// but only the end event carries the complete call, so the earlier
					// events are deliberately ignored. The row stays visible while the
					// tool actually executes, mirroring the pre-v0.84 card.
					this.events.push({ ...ev.activity, ts: Date.now() });
					this.latestActivity = ev.activity;
					this.onActivityChange?.(ev.activity);
					this.onStream?.(ev);
					break;
				}
				case "text_delta": {
					// Fold consecutive text deltas into the current text event.
					const last = this.events[this.events.length - 1];
					if (last?.kind === "text") {
						last.text += ev.delta;
					} else {
						this.events.push({ kind: "text", text: ev.delta, ts: Date.now() });
					}
					// Widget excerpt reflects the latest streamed text.
					this.latestActivity = { kind: "text", text: last?.kind === "text" ? last.text : ev.delta };
					this.onDelta?.(ev.delta);
					this.onStream?.(ev);
					break;
				}
				case "agent_failed":
					this.agentError = ev.error;
					break;
				case "agent_question":
					this.awaitingParent = true;
					this.questionResident = true;
					this.pendingQuestion = ev.question;
					this.onQuestion?.(ev.question);
					break;
				case "agent_msg":
					this.onMessage?.(ev.message);
					break;
				case "agent_tree":
					this.onTreeEvent?.(ev.event);
					break;
			}
		}
	}

	private settle(): void {
		// Count-based: agent_settled fires when the child's run loop finishes —
		// a steer re-runs the loop and settles again, so each post-steer/
		// post-abort turn must be awaited (no one-shot latch). The count also
		// survives settles that arrive while no waiter is attached.
		this.settleCount++;
		for (const waiter of this.settleWaiters) waiter();
		this.settleWaiters.clear();
	}

	/** Wait for the next settle with no framework deadline. */
	private awaitSettled(): Promise<void> {
		if (this.closing || this.client.isClosed) return Promise.resolve();
		if (this.settleCount > this.lastSettledCount) {
			this.lastSettledCount = this.settleCount;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const onSettle = () => {
				this.settleWaiters.delete(onSettle);
				this.lastSettledCount = this.settleCount;
				resolve();
			};
			this.settleWaiters.add(onSettle);
		});
	}
}
