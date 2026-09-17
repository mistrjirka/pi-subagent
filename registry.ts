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
import type { AgentCompletion } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";
import { randomAgentName } from "./name-gen.js";
import { type AgentMessage, type AgentQuestion, type RouteDecision, routeMessage } from "./protocol.js";

/** Narrow agent surface the registry needs — AgentProcess satisfies it. */
export interface RegisteredAgent {
	readonly agentId: string;
	readonly label: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly startedAt?: number;
	status?: "queued" | "running" | "completed" | "failed" | "stopped";
	/** Resident after completion (idle) — explicit opt-in; complete() keeps it. */
	readonly persistent?: boolean;
	/** Runtime residency can also be activated by ask_parent. */
	readonly shouldStayResident?: boolean;
	/** Latest live activity used by wait-timeout/supervision snapshots. */
	getLatestActivity?: () => AgentActivity | undefined;
	/** Deliver one in-tree message to this agent (AgentProcess.sendMessage). */
	sendMessage?: (text: string) => Promise<boolean>;
	stoppedByControl: boolean;
	stop(): Promise<void>;
}

export interface AgentSettlement {
	completion: AgentCompletion;
	waitingForParent?: boolean;
	question?: AgentQuestion;
}

/** Narrow widget surface — index.ts adapts the TUI AgentWidget to it. */
export interface WidgetSurface {
	/** `status` = the row's lifecycle state at registration (background settle = running;
	 *  foreground resident = idle — never a terminal status: the widget's terminal
	 *  cleanup removes such rows immediately). */
	add(agent: RegisteredAgent, status?: "running" | "idle"): void;
	/** `result` feeds the widget's lifetime progress meta; undefined = unknown. */
	remove(agentId: string, result?: WidgetResult): void;
	/** In-place status update (idle ⇄ running for persistent agents). */
	setStatus?(agentId: string, status: "idle" | "running"): void;
	dispose(): void;
}

interface AgentRegistryDeps {
	/** Deliver a completion notification (index.ts wraps pi.sendMessage). */
	notify: (agent: RegisteredAgent, completion: AgentCompletion) => Promise<void> | void;
	/** Fallback supervision reminder for a child left running without an active wait/steer. */
	remind?: (agent: RegisteredAgent, unsupervisedMs: number) => Promise<void> | void;
	/** Default 3 minutes. Set <= 0 to disable reminders. */
	supervisionIntervalMs?: number;
	/** Lazy widget access — null in non-TUI modes. */
	getWidget?: () => WidgetSurface | null;
	/** This process is itself a child agent ("@parent" is deliverable upward). */
	hasParent?: boolean;
}

export class AgentRegistry {
	private readonly agents = new Map<string, RegisteredAgent>();
	private readonly notify: AgentRegistryDeps["notify"];
	private readonly getWidget: NonNullable<AgentRegistryDeps["getWidget"]>;
	private readonly hasParent: boolean;
	/** Latest settled turn for each id; retained so agent_wait can arrive after the notification. */
	private readonly settlements = new Map<string, AgentSettlement>();
	private readonly settlementWaiters = new Map<string, Set<(settlement: AgentSettlement | null | undefined) => void>>();
	private readonly remind: NonNullable<AgentRegistryDeps["remind"]>;
	private readonly supervisionIntervalMs: number;
	private readonly supervisionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly supervisedAgents = new Set<string>();
	private parentActive = true;
	private readonly activeWaits = new Map<string, number>();
	private readonly lastSupervisedAt = new Map<string, number>();
	/** Names handed out this session — re-roll on collision (pool ~200). */
	private readonly usedNames = new Set<string>();

	constructor(deps: AgentRegistryDeps) {
		this.notify = deps.notify;
		this.remind = deps.remind ?? (() => {});
		this.supervisionIntervalMs = deps.supervisionIntervalMs ?? 180_000;
		this.getWidget = deps.getWidget ?? (() => null);
		this.hasParent = deps.hasParent ?? false;
	}

	/**
	 * Short human-name id (max, zoe, kai…) — the LLM-facing agent reference
	 * for this session (agent_send targets, notification JSON). Names read
	 * as names (not machine codes) and cost ~1 token each; uniqueness is
	 * this session's live set (re-roll on collision).
	 */
	nextAgentId(): string {
		const name = randomAgentName(this.usedNames);
		this.usedNames.add(name);
		return name;
	}

	/** Track a background agent: registry entry + widget row. */
	register(agent: RegisteredAgent, status: "running" | "idle" = "running"): void {
		this.settlements.delete(agent.agentId);
		this.agents.set(agent.agentId, agent);
		this.getWidget()?.add(agent, status);
	}

	lookup(agentId: string): RegisteredAgent | undefined {
		return this.agents.get(agentId);
	}

	/** Record a child turn settling and wake any explicit agent_wait callers. Returns true when a waiter consumed it live. */
	recordSettlement(agentId: string, settlement: AgentSettlement): boolean {
		this.stopSupervision(agentId);
		this.settlements.set(agentId, settlement);
		const waiters = this.settlementWaiters.get(agentId);
		if (!waiters?.size) return false;
		this.settlementWaiters.delete(agentId);
		for (const resolve of waiters) resolve(settlement);
		return true;
	}

	/** Start/restart fallback supervision for a live direct child. */
	startSupervision(agentId: string): void {
		if (this.supervisionIntervalMs <= 0 || !this.agents.has(agentId)) return;
		this.supervisedAgents.add(agentId);
		this.lastSupervisedAt.set(agentId, Date.now());
		this.scheduleSupervision(agentId);
	}

	/** Parent started/resumed a model turn: reminders are unnecessary while it is actively supervising. */
	parentBecameActive(): void {
		this.parentActive = true;
		for (const timer of this.supervisionTimers.values()) clearTimeout(timer);
		this.supervisionTimers.clear();
	}

	/** Parent ended its turn: begin a fresh unsupervised window for every live tracked child. */
	parentBecameIdle(): void {
		this.parentActive = false;
		const now = Date.now();
		for (const agentId of this.supervisedAgents) {
			this.lastSupervisedAt.set(agentId, now);
			this.scheduleSupervision(agentId);
		}
	}

	/** Reset an already-active supervision clock without enabling supervision for a new child. */
	touchSupervision(agentId: string): void {
		if (!this.supervisedAgents.has(agentId)) {
			return;
		}
		this.lastSupervisedAt.set(agentId, Date.now());
		this.scheduleSupervision(agentId);
	}

	private scheduleSupervision(agentId: string): void {
		const existing = this.supervisionTimers.get(agentId);
		if (existing) clearTimeout(existing);
		this.supervisionTimers.delete(agentId);
		if (
			this.supervisionIntervalMs <= 0 ||
			this.parentActive ||
			!this.supervisedAgents.has(agentId) ||
			(this.activeWaits.get(agentId) ?? 0) > 0
		)
			return;
		const agent = this.agents.get(agentId);
		if (!agent || (agent.status && agent.status !== "running" && agent.status !== "queued")) return;
		const timer = setTimeout(() => {
			this.supervisionTimers.delete(agentId);
			const current = this.agents.get(agentId);
			if (!current || (current.status && current.status !== "running" && current.status !== "queued")) return;
			if (this.parentActive || (this.activeWaits.get(agentId) ?? 0) > 0) return;
			const now = Date.now();
			const since = now - (this.lastSupervisedAt.get(agentId) ?? now);
			this.lastSupervisedAt.set(agentId, now);
			void Promise.resolve(this.remind(current, since)).catch(() => {});
			this.scheduleSupervision(agentId);
		}, this.supervisionIntervalMs);
		this.supervisionTimers.set(agentId, timer);
	}

	private pauseSupervision(agentId: string): void {
		const n = (this.activeWaits.get(agentId) ?? 0) + 1;
		this.activeWaits.set(agentId, n);
		const timer = this.supervisionTimers.get(agentId);
		if (timer) clearTimeout(timer);
		this.supervisionTimers.delete(agentId);
	}

	private resumeSupervision(agentId: string): void {
		const n = Math.max(0, (this.activeWaits.get(agentId) ?? 0) - 1);
		if (n) this.activeWaits.set(agentId, n);
		else this.activeWaits.delete(agentId);
		if (!this.supervisedAgents.has(agentId)) return;
		this.lastSupervisedAt.set(agentId, Date.now());
		if (n === 0) this.scheduleSupervision(agentId);
	}

	private stopSupervision(agentId: string): void {
		const timer = this.supervisionTimers.get(agentId);
		if (timer) clearTimeout(timer);
		this.supervisionTimers.delete(agentId);
		this.supervisedAgents.delete(agentId);
		this.activeWaits.delete(agentId);
		this.lastSupervisedAt.delete(agentId);
	}

	/**
	 * Block until this direct child settles. When timeoutMs is provided, null
	 * means the child is still running; the timeout never stops the child.
	 */
	async waitForSettlement(
		agentId: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<AgentSettlement | null | undefined> {
		const cached = this.settlements.get(agentId);
		if (cached) return cached;
		if (!this.agents.has(agentId)) return undefined;
		if (signal?.aborted) throw new Error("agent_wait cancelled");
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new Error("agent_wait timeout must be a finite non-negative duration");
		}
		this.pauseSupervision(agentId);
		if (timeoutMs === 0) {
			this.resumeSupervision(agentId);
			return null;
		}
		return await new Promise<AgentSettlement | null | undefined>((resolve, reject) => {
			const waiters = this.settlementWaiters.get(agentId) ?? new Set();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				signal?.removeEventListener("abort", onAbort);
				if (timer) clearTimeout(timer);
				this.resumeSupervision(agentId);
			};
			const finish = (settlement: AgentSettlement | null | undefined) => {
				cleanup();
				resolve(settlement);
			};
			const detachWaiter = () => {
				waiters.delete(finish);
				if (waiters.size === 0) this.settlementWaiters.delete(agentId);
			};
			const onAbort = () => {
				detachWaiter();
				cleanup();
				reject(new Error("agent_wait cancelled"));
			};
			waiters.add(finish);
			this.settlementWaiters.set(agentId, waiters);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					detachWaiter();
					finish(null);
				}, timeoutMs);
			}
		});
	}

	/** A successful steer/answer starts a new turn, so future waits must observe the next settlement. */
	clearSettlement(agentId: string): void {
		this.settlements.delete(agentId);
	}

	/**
	 * Completion policy + cleanup, single choke point. Notifies unless the
	 * stop was user-controlled; always removes the bookkeeping and stops the
	 * child (idempotent — safe for never-registered spawn failures and for
	 * completions arriving after stopAndRemove). A persistent agent that
	 * completed stays registered (idle, process resident) — agent_stop
	 * removes it later.
	 */
	async complete(agent: RegisteredAgent, completion: AgentCompletion): Promise<void> {
		const waited = this.recordSettlement(agent.agentId, { completion });
		const notify = () => (agent.stoppedByControl || waited ? Promise.resolve() : this.notify(agent, completion));
		if ((agent.shouldStayResident ?? agent.persistent) && completion.status === "completed") {
			try {
				// A failed notification must never kill a resident agent — the
				// idle row stays (addressable), the agent stays up.
				await Promise.resolve(notify()).catch(() => {});
			} finally {
				// Resident — no remove, no stop. The widget row flips to idle so
				// the agent stays addressable (agent_stop removes it later).
				this.getWidget()?.setStatus?.(agent.agentId, "idle");
			}
			return;
		}
		try {
			await notify();
		} finally {
			this.remove(agent.agentId, completion.status === "completed" ? "done" : completion.status);
			await agent.stop().catch(() => {});
		}
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
	async deliver(target: string, text: string): Promise<boolean> {
		const agent = this.agents.get(target);
		if (!agent?.sendMessage) return false;
		const ok = await agent.sendMessage(text);
		if (ok) {
			this.clearSettlement(target);
			this.touchSupervision(target);
		}
		// A delivered message woke an idle persistent agent — the widget row
		// flips back to running (spinner resumes). Harmless for running rows.
		if (ok) this.getWidget()?.setStatus?.(target, "running");
		return ok;
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
		await agent.stop();
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
	async shutdown(): Promise<void> {
		for (const agentId of this.agents.keys()) this.stopSupervision(agentId);
		for (const waiters of this.settlementWaiters.values()) for (const resolve of waiters) resolve(undefined);
		this.settlementWaiters.clear();
		for (const agent of this.agents.values()) {
			void agent.stop();
		}
		this.agents.clear();
		this.getWidget()?.dispose();
	}

	private remove(agentId: string, result?: WidgetResult): void {
		this.stopSupervision(agentId);
		// Only touch the widget for agents we actually tracked — a spawn-
		// failure completion never registered, so delete() returns false and
		// the widget stays untouched (no spurious requestRender).
		if (this.agents.delete(agentId)) this.getWidget()?.remove(agentId, result);
	}
}
