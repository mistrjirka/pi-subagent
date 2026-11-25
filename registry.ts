import { DEFAULT_WAIT_TIMEOUT_SECONDS } from "./wait-policy.js";
/**
 * pi-subagent — AgentRegistry.
 *
 * Owns the set of running background agents and the "what happens when an
 * agent finishes" policy — bookkeeping that used to live inline in index.ts
 * tool executes (registry map + widget row + child process kept in sync in
 * three call sites: agent_spawn.execute, agent_stop.execute, session_shutdown).
 *
 * The registry depends on narrow seams — a notify callback and a widget
 * surface — so the completion policy is unit-testable without a pi API or a
 * TUI. AgentProcess satisfies RegisteredAgent structurally; index.ts adapts
 * the TUI widget via WidgetSurface.
 *
 * Policy (mirroring the previous inline wiring):
 *   - agent_stop is a deliberate user action → no notification (B6).
 *   - Non-user-controlled stopped completions still notify with status "stopped".
 *   - Every terminal path cleans up exactly once (remove is idempotent).
 * Ordering note: the original wiring stopped the child *before* notifying on
 * the spawn-failure path (D15) but *after* notifying on the completion path;
 * complete() unifies both to notify → cleanup — no observable difference.
 */

import type { WidgetResult } from "@everyx/pi-ui/widget.js";
import { AgentNameAllocator } from "./agent-name-allocator.js";
import type { AgentCompletion } from "./agent-process.js";
import { AgentWaitCoordinator } from "./agent-wait-coordinator.js";
import { DiagnosticDeduplicator } from "./diagnostic-dedup.js";
import { type AgentMessage, type AgentQuestion, type RouteDecision, routeMessage } from "./protocol.js";
import type { PendingAnnouncement } from "./registry-contracts.js";
import {
	type AgentRegistryDeps,
	type AgentSettlement,
	type AgentWaitEvent,
	type AgentWaitMessage,
	ANCESTOR_IDS_ENV,
	parseAncestorIds,
	type RegisteredAgent,
	type WidgetSurface,
} from "./registry-contracts.js";
import { checkpointRoster, describeMessageTargets } from "./registry-roster.js";
import { SupervisionService } from "./supervision.js";

export type {
	AgentSettlement,
	AgentWaitCoalesced,
	AgentWaitEvent,
	AgentWaitMessage,
	RegisteredAgent,
	WidgetSurface,
} from "./registry-contracts.js";
export {
	ANCESTOR_IDS_ENV,
	buildAncestorChain,
	parseAncestorIds,
} from "./registry-contracts.js";

export class AgentRegistry {
	private readonly agents = new Map<string, RegisteredAgent>();
	private readonly notify: AgentRegistryDeps["notify"];
	private readonly getWidget: NonNullable<AgentRegistryDeps["getWidget"]>;
	private readonly hasParent: boolean;
	/** Latest settled turn for each id; retained so agent_wait can arrive after completion. */
	private readonly settlements = new Map<string, AgentSettlement>();
	private readonly waits: AgentWaitCoordinator;
	/**
	 * Completion/question announcements that settled during an active parent turn.
	 * They are flushed at the next completed tool/model boundary, unless a
	 * wait or inspection consumes the cached settlement first. This prevents a stale queued
	 * follow-up from arriving after the model already read the same result.
	 */
	private readonly pendingAnnouncements = new Map<string, PendingAnnouncement>();
	/** Progress received while the parent was actively running. */
	private readonly pendingParentMessages: AgentMessage[] = [];
	/** Child progress already delivered to the parent this task. A later
	 * completion must remain visible but must not wake the model twice. */
	private readonly deliveredParentProgress = new Set<string>();
	private readonly supervision: SupervisionService;
	private parentActive = true;
	private closing = false;
	private shutdownPromise: Promise<void> | undefined;
	private readonly stoppedIds = new Set<string>();
	/** Names handed out this session — re-roll on collision (pool ~200). */
	private readonly names: AgentNameAllocator;
	private readonly diagnosticDedup = new DiagnosticDeduplicator();

	constructor(deps: AgentRegistryDeps) {
		this.notify = deps.notify;
		this.supervision = new SupervisionService({
			lookup: (agentId) => this.agents.get(agentId),
			remind: deps.remind ?? (() => {}),
			intervalMs: deps.supervisionIntervalMs ?? DEFAULT_WAIT_TIMEOUT_SECONDS * 1000,
		});
		this.waits = new AgentWaitCoordinator(this.supervision);
		this.getWidget = deps.getWidget ?? (() => null);
		this.hasParent = deps.hasParent ?? false;
		const seeds = deps.seedNames ?? parseAncestorIds(process.env[ANCESTOR_IDS_ENV]);
		this.names = new AgentNameAllocator(seeds);
	}

	/** Allocate a unique short child name, reserving ancestor names. */
	nextAgentId(): string {
		return this.names.next();
	}

	/** Track a background agent: registry entry + widget row. */
	register(agent: RegisteredAgent, status: "running" | "idle" = "running"): void {
		if (this.closing) throw new Error("Cannot register a child in a closing session.");
		this.settlements.delete(agent.agentId);
		this.deliveredParentProgress.delete(agent.agentId);
		this.agents.set(agent.agentId, agent);
		this.getWidget()?.add(agent, status);
	}

	lookup(agentId: string): RegisteredAgent | undefined {
		return this.agents.get(agentId);
	}

	/** Snapshot used by compaction. It never reads child transcripts or changes the registry. */
	checkpointRoster(limit = 24): ReturnType<typeof checkpointRoster> {
		return checkpointRoster(this.agents, limit);
	}

	describeMessageTargets(target: string, limit = 8): string {
		return describeMessageTargets(this.agents, this.settlements, target, limit);
	}

	wasDiagnosticSentRecently(target: string, message: string, now = Date.now()): boolean {
		return this.diagnosticDedup.wasSentRecently(target, message, now);
	}

	recordSentDiagnostic(target: string, message: string, now = Date.now()): void {
		this.diagnosticDedup.recordSent(target, message, now);
	}

	/** Known completed tasks remain inspectable after their processes exit. */
	peekSettlement(agentId: string): AgentSettlement | undefined {
		return this.settlements.get(agentId);
	}

	/** Reading a complete settled result acknowledges its queued announcement. */
	consumeSettlement(agentId: string, expected?: AgentSettlement): AgentSettlement | undefined {
		const settlement = this.settlements.get(agentId);
		if (expected && settlement !== expected) return undefined;
		if (settlement) this.pendingAnnouncements.delete(agentId);
		return settlement;
	}

	/** A preview is not delivery. Call only after selecting the actual result for return. */
	acknowledgeSettlement(agentId: string, expected: AgentSettlement): void {
		const current = this.consumeSettlement(agentId, expected);
		if (current) current.deliveredInToolResult = true;
	}

	/** Announce unread completions only when the parent has fully settled. */
	parentReachedBoundary(): void {
		// An earlier turn_end is not safe: a later agent_wait may still consume the
		// completion, but cannot retract a steer already queued inside Pi.
		if (this.parentActive) return;
		const pending = [...this.pendingAnnouncements.values()];
		this.pendingAnnouncements.clear();
		for (const item of pending) void Promise.resolve(item.announce()).catch(() => {});
	}

	/** Mark progress only after actual parent delivery. A diagnostic ping does
	 * not establish that the task's substantive result was already received. */
	noteDeliveredParentMessage(message: AgentMessage): void {
		const id = message.from.startsWith("@") ? message.from.slice(1) : message.from;
		if (message.kind === "diagnostic" || !(this.agents.has(id) || this.settlements.has(id))) return;
		this.deliveredParentProgress.add(id);
	}

	/** Buffer progress until the next tool result, but never suppress progress messages. */
	queueParentMessageIfActive(message: AgentMessage): boolean {
		if (this.closing || !this.parentActive) return false;
		this.pendingParentMessages.push(message);
		return true;
	}

	/** Claim pending updates exactly once for a model-visible tool result. */
	takePendingForToolResult(
		maxMessages = 16,
		maxCompletions = 4,
	): {
		messages: AgentMessage[];
		completions: Array<{ agent: RegisteredAgent; completion: AgentCompletion }>;
	} {
		const messages = this.pendingParentMessages.splice(0, maxMessages);
		for (const message of messages) this.noteDeliveredParentMessage(message);
		const completions: Array<{ agent: RegisteredAgent; completion: AgentCompletion }> = [];
		for (const [id, item] of this.pendingAnnouncements) {
			if (!item.inline || completions.length >= maxCompletions) continue;
			const settlement = this.settlements.get(id);
			if (!settlement || settlement.completion !== item.inline.completion) continue;
			settlement.deliveredInToolResult = true;
			completions.push(item.inline);
			this.pendingAnnouncements.delete(id);
		}
		return { messages, completions };
	}

	/** Retrieve remaining progress for the original asynchronous notification path. */
	takePendingParentMessages(): AgentMessage[] {
		return this.pendingParentMessages.splice(0);
	}

	acceptsCompletion(agent: RegisteredAgent, completion: AgentCompletion): boolean {
		return (
			!this.closing &&
			!this.stoppedIds.has(agent.agentId) &&
			(!agent.stoppedByControl || completion.status === "stopped") &&
			(completion.generation === undefined || completion.generation === agent.generation)
		);
	}

	/**
	 * Record a child turn settling and wake explicit agent_wait callers.
	 * If nobody is already waiting, an optional announcement is either sent
	 * immediately while the parent is idle or deferred until its next safe boundary.
	 * A complete result read by wait/inspect cancels that announcement.
	 */
	recordSettlement(
		agentId: string,
		settlement: AgentSettlement,
		announce?: () => Promise<void> | void,
		inline?: { agent: RegisteredAgent; completion: AgentCompletion },
	): boolean {
		const live = this.agents.get(agentId);
		if (
			this.closing ||
			(this.stoppedIds.has(agentId) && settlement.completion.status !== "stopped") ||
			(live && settlement.completion.generation !== undefined && settlement.completion.generation !== live.generation)
		)
			return false;
		this.supervision.stop(agentId);
		// A new settlement supersedes any unannounced result from an earlier turn.
		this.pendingAnnouncements.delete(agentId);
		this.settlements.set(agentId, settlement);
		if (this.waits.settle(agentId, settlement)) return true;
		if (announce) {
			if (settlement.waitingForParent && settlement.question) {
				// ask_parent must reach the next model boundary, not wait for the
				// parent to settle. Mark before queueing so a later agent_wait does
				// not repeat the same question as a tool result.
				settlement.questionAnnounced = true;
				void Promise.resolve(announce()).catch(() => {});
			} else if (this.parentActive) this.pendingAnnouncements.set(agentId, { announce, inline });
			else void Promise.resolve(announce()).catch(() => {});
		}
		return false;
	}

	/**
	 * A child sending @parent must wake a parent blocked in any agent_wait,
	 * including one watching a different child. The wait's tool result delivers
	 * the message to the model, so the caller must not also queue a steer.
	 * Outside a wait, the existing pi.sendMessage path remains authoritative.
	 */
	wakeWaitForMessage(message: AgentMessage): boolean {
		if (this.closing || !this.waits.wakeForMessage(message)) return false;
		this.noteDeliveredParentMessage(message);
		return true;
	}

	/** Start/restart fallback supervision for a live direct child. */
	startSupervision(agentId: string): void {
		this.supervision.start(agentId);
	}

	parentBecameActive(): void {
		this.parentActive = true;
		this.supervision.parentBecameActive();
	}

	/** Only a fully idle parent can announce deferred results. */
	parentBecameIdle(): void {
		this.parentActive = false;
		this.parentReachedBoundary();
		this.supervision.parentBecameIdle();
	}

	touchSupervision(agentId: string): void {
		this.supervision.touch(agentId);
	}

	/**
	 * Block until this direct child settles. When timeoutMs is provided, null
	 * means the child is still running; the timeout never stops the child.
	 */
	waitForSettlement(
		agentId: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<AgentSettlement | null | undefined>;
	waitForSettlement(
		agentId: string,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
		wakeOnMessage: true,
	): Promise<AgentSettlement | AgentWaitEvent | null | undefined>;
	async waitForSettlement(
		agentId: string,
		signal?: AbortSignal,
		timeoutMs?: number,
		wakeOnMessage = false,
	): Promise<AgentSettlement | AgentWaitEvent | null | undefined> {
		const cached = this.consumeSettlement(agentId);
		if (cached) {
			// A cached result consumed by agent_wait suppresses its queued
			// asynchronous notification.
			this.pendingAnnouncements.delete(agentId);
			return cached;
		}
		if (!this.agents.has(agentId)) return undefined;
		return await this.waits.wait(agentId, signal, timeoutMs, wakeOnMessage);
	}

	/** A successful steer/answer starts a new turn, so future waits must observe the next settlement. */
	clearSettlement(agentId: string): void {
		this.settlements.delete(agentId);
		this.pendingAnnouncements.delete(agentId);
		this.deliveredParentProgress.delete(agentId);
	}

	/**
	 * Completion policy + cleanup, single choke point. Notifies unless the
	 * stop was user-controlled; always removes the bookkeeping and stops the
	 * child (idempotent — safe for never-registered spawn failures and for
	 * completions arriving after stopAndRemove). A persistent agent that
	 * completed stays registered (idle, process resident) — agent_stop
	 * removes it later.
	 */
	async complete(agent: RegisteredAgent, completion: AgentCompletion): Promise<boolean> {
		if (!this.acceptsCompletion(agent, completion)) return false;
		this.recordSettlement(
			agent.agentId,
			{ completion },
			agent.stoppedByControl
				? undefined
				: () =>
						this.notify(agent, completion, {
							triggerTurn: !this.deliveredParentProgress.has(agent.agentId),
						}),
			agent.stoppedByControl ? undefined : { agent, completion },
		);
		if ((agent.shouldStayResident ?? agent.persistent) && completion.status === "completed") {
			// Resident — no remove, no stop. Notification delivery is owned by
			// recordSettlement: immediate when the parent is idle, deferred while
			// active, or suppressed if agent_wait consumes the settlement first.
			this.getWidget()?.setStatus?.(agent.agentId, "idle");
			return true;
		}
		this.remove(agent.agentId, completion.status === "completed" ? "done" : completion.status);
		await agent.stop();
		return true;
	}

	/**
	 * Route one message against my direct children (pure; the caller — the
	 * agent_send execute or the inbound handler — acts on the decision:
	 * deliver to a child / inject the parent LLM / error).
	 */
	route(msg: AgentMessage): RouteDecision {
		return routeMessage(msg, [...this.agents.keys()], this.hasParent);
	}

	/** Point-to-point delivery to a direct child by exact id. */
	async deliver(target: string, text: string, answerToQuestion = false): Promise<boolean> {
		if (this.closing) return false;
		const agent = this.agents.get(target);
		if (!agent?.sendMessage || this.stoppedIds.has(target)) return false;
		if (agent.awaitingParent && !answerToQuestion) return false;
		const previous = this.settlements.get(target);
		const announcement = this.pendingAnnouncements.get(target);
		const priorProgressDelivered = this.deliveredParentProgress.has(target);
		// Invalidate before suspension: never erase a completion produced while
		// the RPC acknowledgement is in flight.
		this.clearSettlement(target);
		const ok = await agent.sendMessage(text);
		if (this.closing || this.stoppedIds.has(target)) return false;
		if (this.agents.get(target) !== agent) return ok;
		if (!ok) {
			// Failed send did not begin another task. Preserve the receipt unless
			// a concurrent new settlement superseded the generation.
			if (priorProgressDelivered && !this.settlements.has(target)) this.deliveredParentProgress.add(target);
			if (previous && !this.settlements.has(target) && agent.status !== "running") {
				this.settlements.set(target, previous);
				if (announcement) this.pendingAnnouncements.set(target, announcement);
			}
			return false;
		}
		const settled = this.settlements.get(target);
		if (settled?.completion.generation !== undefined && settled.completion.generation !== agent.generation)
			this.clearSettlement(target);
		this.touchSupervision(target);
		this.getWidget()?.setStatus?.(target, agent.status === "completed" ? "idle" : "running");
		return true;
	}

	/** Flip a persistent agent's widget row back to idle (wake finished). */
	markIdle(agentId: string): void {
		this.getWidget()?.setStatus?.(agentId, "idle");
	}

	/** agent_stop path: graceful stop + removal (no notification).
	 *  Returns whether an agent was actually stopped (false when it finished
	 *  between lookup and removal). A rejecting stop() propagates — the
	 *  caller (agent_stop.execute) surfaces it as a tool error, matching
	 *  the original wiring. */
	async stopAndRemove(agentId: string): Promise<boolean> {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		// Mark stopped FIRST, synchronously: a completion landing while
		// `await agent.stop()` is in flight must observe stoppedByControl
		// and suppress its notification (stop/complete race). stop() also
		// flags the stop itself, but only after the transport shutdown it
		// awaits — too late to close the window.
		this.stoppedIds.add(agentId);
		agent.markStopped();
		await agent.stop();
		// An already-settled resident agent (completed/idle) is untouched by
		// stop()'s early return, which would leave the control bridge
		// heartbeating idle forever — the markStopped() above already
		// recorded the explicit stop as terminal so the bridge's existing
		// terminal check winds it down. Never applied on the normal
		// completion path (complete() must keep completed/failed).
		this.recordSettlement(agentId, {
			completion: {
				status: "stopped",
				output: "Agent stopped.",
				stats: { tokens: 0, toolUses: 0, durationMs: 0 },
			},
		});
		this.remove(agentId, "stopped");
		return true;
	}

	/** Stop everything (session shutdown). */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closing = true;
		const owned = [...this.agents.values()];
		for (const agent of owned) {
			this.stoppedIds.add(agent.agentId);
			agent.markStopped();
			this.supervision.stop(agent.agentId);
		}
		this.waits.shutdown();
		this.pendingAnnouncements.clear();
		this.pendingParentMessages.length = 0;
		this.deliveredParentProgress.clear();
		this.settlements.clear();
		this.shutdownPromise = (async () => {
			const results = await Promise.allSettled(owned.map((agent) => agent.stop()));
			this.agents.clear();
			this.getWidget()?.dispose();
			const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
			if (errors.length) throw new AggregateError(errors, "Subagent session cleanup failed.");
		})();
		return this.shutdownPromise;
	}

	private remove(agentId: string, result?: WidgetResult): void {
		this.supervision.stop(agentId);
		// Only touch the widget for agents we actually tracked — a spawn-
		// failure completion never registered, so delete() returns false and
		// the widget stays untouched (no spurious requestRender).
		if (this.agents.delete(agentId)) this.getWidget()?.remove(agentId, result);
	}
}
