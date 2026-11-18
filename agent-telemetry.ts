import type { AgentEvent } from "./event-interpret.js";

export type RunningTool = {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	timeoutSeconds?: number;
};

/** A small, typed, event-owned snapshot. It never reads the session transcript. */
export type AgentTelemetrySnapshot = {
	turnCount: number;
	toolCount: number;
	windowTokens?: number;
	lastActivityAt?: number;
	activeTools?: RunningTool[];
};

export type TelemetryChange = { changed: boolean; emitStream: boolean };

/**
 * Owns execution counters and the latest model usage for one child process.
 * Only final tool execution/results can end a command. Heartbeats do not count
 * as activity and runtime state is never inferred from the age of an event.
 */
export class AgentTelemetryService {
	private completedTurns = 0;
	private executedTools = 0;
	private windowTokens: number | undefined;
	private lastActivityAt: number | undefined;
	private readonly activeTools = new Map<string, RunningTool>();

	observe(event: AgentEvent, now = Date.now()): TelemetryChange {
		switch (event.type) {
			case "assistant_end": {
				this.completedTurns += 1;
				if (event.windowTokens !== undefined) this.windowTokens = event.windowTokens;
				this.lastActivityAt = now;
				return { changed: true, emitStream: true };
			}
			case "tool_execution_start": {
				if (!this.activeTools.has(event.toolCallId)) this.executedTools += 1;
				this.activeTools.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startedAt: now,
					...(event.timeoutSeconds !== undefined ? { timeoutSeconds: event.timeoutSeconds } : {}),
				});
				this.lastActivityAt = now;
				return { changed: true, emitStream: true };
			}
			case "tool_execution_end":
			case "tool_result_end": {
				const active = this.activeTools.get(event.toolCallId);
				if (!active || active.toolName !== event.toolName) {
					return { changed: false, emitStream: false };
				}
				this.activeTools.delete(event.toolCallId);
				this.lastActivityAt = now;
				return { changed: true, emitStream: true };
			}
			default:
				return { changed: false, emitStream: true };
		}
	}

	snapshot(): AgentTelemetrySnapshot {
		return {
			turnCount: this.completedTurns,
			toolCount: this.executedTools,
			...(this.windowTokens !== undefined ? { windowTokens: this.windowTokens } : {}),
			...(this.lastActivityAt !== undefined ? { lastActivityAt: this.lastActivityAt } : {}),
			...(this.activeTools.size > 0 ? { activeTools: [...this.activeTools.values()] } : {}),
		};
	}
}
