/** Shared registry contracts and validated ancestor-ID utilities. */
import type { WidgetResult } from "@everyx/pi-ui/widget.js";
import type { AgentCompletion } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";
import type { MonitoringProgress } from "./monitoring-progress.js";
import type { AgentMessage, AgentQuestion } from "./protocol.js";
import type { RenderEvent } from "./types.js";

/** Narrow agent surface the registry needs — AgentProcess satisfies it. */
export interface RegisteredAgent {
	readonly agentId: string;
	readonly label: string;
	readonly taskSummary?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly startedAt?: number;
	readonly generation?: number;
	readonly awaitingParent?: boolean;
	status?: "queued" | "running" | "completed" | "failed" | "stopped";
	/** Resident after completion (idle) — explicit opt-in; complete() keeps it. */
	readonly persistent?: boolean;
	/** Runtime residency can also be activated by ask_parent. */
	readonly shouldStayResident?: boolean;
	/** Latest live activity used by wait-timeout/supervision snapshots. */
	getLatestActivity?: () => AgentActivity | undefined;
	getMonitoringProgress?: (consume?: boolean) => MonitoringProgress;
	/** Actual live Pi conversation messages for transcript inspection. */
	getMessages?: () => Promise<unknown[]>;
	/** Append-ordered Pi session entries; `since` is a stable entry id cursor. */
	getEntries?: (since?: string) => Promise<{ entries: unknown[]; leafId: string | null }>;
	/** In-memory event trace fallback when RPC/persisted session inspection is unavailable. */
	getEvents?: () => RenderEvent[];
	/** Persisted child session file, when available. */
	readonly sessionPath?: string;
	/** Deliver one in-tree message to this agent (AgentProcess.sendMessage). */
	sendMessage?: (text: string) => Promise<boolean>;
	stoppedByControl: boolean;
	stop(): Promise<void>;
	/** Record an explicit user stop as terminal (AgentProcess.markStopped):
	 *  idempotent, flags the stop as user-controlled, never overwrites failed. */
	markStopped(): void;
}

export interface AgentSettlement {
	completion: AgentCompletion;
	/** Already included in a parent tool result, so agent_wait must not repeat it. */
	deliveredInToolResult?: boolean;
	waitingForParent?: boolean;
	question?: AgentQuestion;
	/** Question already sent to Pi's steering queue; agent_wait must not repeat it. */
	questionAnnounced?: boolean;
}

/** An ordinary child message interrupts agent_wait without settling the child. */
export interface AgentWaitMessage {
	kind: "message";
	message: AgentMessage;
}

/** The other parallel waiters resume without repeating one child's payload. */
export interface AgentWaitCoalesced {
	kind: "other_wait";
	reason: "message" | "completion";
}
export type AgentWaitEvent = AgentWaitMessage | AgentWaitCoalesced;

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

export interface AgentRegistryDeps {
	/** Deliver a completion notification. A passive delivery is visible and
	 * persisted without waking another model turn. */
	notify: (
		agent: RegisteredAgent,
		completion: AgentCompletion,
		delivery: { triggerTurn: boolean },
	) => Promise<void> | void;
	/** Fallback supervision reminder for a child left running without an active wait/steer. */
	remind?: (agent: RegisteredAgent, unsupervisedMs: number) => Promise<void> | void;
	/** Default 150 seconds. Set <= 0 to disable reminders. */
	supervisionIntervalMs?: number;
	/** Lazy widget access — null in non-TUI modes. */
	getWidget?: () => WidgetSurface | null;
	/** This process is itself a child agent ("@parent" is deliverable upward). */
	hasParent?: boolean;
	/**
	 * Ancestor/cousin names the child's own spawns must never re-roll
	 * (cross-process collision guard — see ANCESTOR_IDS_ENV). When omitted,
	 * the constructor falls back to parsing the env var itself, so a child
	 * process spawned with the chain is seeded with no extra wiring.
	 */
	seedNames?: readonly string[];
}

/**
 * Env var carrying the comma-separated ancestor id chain to a child process
 * (own id first, then ancestors up to the root). Seeded into the child's
 * registry so `nextAgentId` can never re-roll an ancestor/cousin name —
 * consumers rendering the whole tree keyed by bare id (PiTTy does) would
 * otherwise see two different agents under one id.
 */
export const ANCESTOR_IDS_ENV = "PI_SUBAGENT_ANCESTOR_IDS";

/** Single id charset: the name-gen pool is lowercase alpha (see name-gen.ts). */
export const ANCESTOR_ID_PATTERN = /^[a-z]{1,64}$/;

/**
 * Parse an ancestor-chain env value into validated ids (deduped, order
 * preserved). Malformed entries are dropped; absent/malformed input yields
 * [] — today's behavior exactly (no seeding).
 */
export function parseAncestorIds(raw: string | undefined | null): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const part of raw.split(",")) {
		const id = part.trim();
		if (!ANCESTOR_ID_PATTERN.test(id) || seen.has(id)) continue;
		seen.add(id);
	}
	return [...seen];
}

/**
 * Build the chain value a spawner passes to its child: the child's own id
 * first, then this process's id (when it has one — "" = root session),
 * then the chain inherited from our own parent. Deduped, order preserved.
 */
export function buildAncestorChain(newId: string, ownId: string, inheritedRaw: string | undefined): string {
	const seen = new Set<string>();
	const chain: string[] = [];
	for (const id of [newId, ownId, ...parseAncestorIds(inheritedRaw)]) {
		if (!id || !ANCESTOR_ID_PATTERN.test(id) || seen.has(id)) continue;
		seen.add(id);
		chain.push(id);
	}
	return chain.join(",");
}

/** Completion notification held across a parent turn. */
export interface PendingAnnouncement {
	announce: () => Promise<void> | void;
	inline?: { agent: RegisteredAgent; completion: AgentCompletion };
}
