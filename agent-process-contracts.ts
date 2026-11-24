import type { RequestPerformance } from "./request-performance.js";
/** Typed process options and completion contracts, independent of transport. */
import type { AgentActivity, AgentEvent, AgentTreeEvent } from "./event-interpret.js";
import type { AgentMessage, AgentQuestion } from "./protocol.js";

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export type TerminalStatus = Exclude<AgentStatus, "queued" | "running">;

export interface AgentStats {
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
	/** Completed, genuinely streamed model request. */
	onPerformance?: (performance: RequestPerformance) => void;
	cwd: string;
	/** Resolved "provider/id" model string, or inherit when omitted. */
	model?: string;
	/** Reasoning intensity ("off"…"max"), passed as --thinking. */
	thinking?: string;
	/** Extra role guidance appended to Pi's normal system prompt. */
	appendSystemPrompt?: string;
	/** Short task label (notification card). */
	label: string;
	/** Task preview for compaction, not a transcript or full prompt. */
	taskSummary?: string;
	/** Short human-readable id ("max", "zoe") assigned by the registry (name-gen.ts). */
	agentId: string;
	/** Custom session storage dir (--session-dir) — keeps sub-agent sessions out of `pi -r`. */
	sessionDir?: string;
	/** Existing session file to load instead of starting with a blank context. */
	resumeSessionPath?: string;
	/** Called when Pi confirms its saved session path (used for durable recovery). */
	onSessionReady?: (sessionPath: string, sessionId?: string) => void;
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
