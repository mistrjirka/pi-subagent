/**
 * pi-subagent — completion notification payload construction.
 *
 * One module owns every rule about what a completion notification says and
 * to whom: the LLM-visible JSON (capped, stash-marked), the user-side
 * details card (full output, never enters LLM context), and the context
 * budget helpers shared with foreground results (truncateForContext /
 * maybeWriteFullOutput). render.ts reads the same NotificationDetails —
 * the shape has a single producer, so it cannot drift by hand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentCompletion } from "./agent-process.js";
import type { RegisteredAgent } from "./registry.js";
import { resultOverflowMarker, resultPreview } from "./result-output.js";
import type { NotificationDetails } from "./types.js";
import { agentTitle } from "./views.js";

/**
 * LLM-visible output cap: details.events stay complete, so folding/expansion
 * never loses content for the user; the session file has everything. Single
 * exit for every path that produces LLM-visible output (foreground result,
 * background notification).
 */
export function truncateForContext(text: string): string {
	return resultPreview(text);
}

/**
 * When an output exceeds the context cap, stash the full text (bounded
 * result artifact) and return the LLM-visible marker embedded
 * in the result: the model reads the truncated preview and knows the full
 * output is one `read` away. Returns the marker when truncated, "" otherwise.
 */
export function maybeWriteFullOutput(agentId: string, output: string): string {
	return resultOverflowMarker(agentId, output);
}

/** The exact content seen by the model, whether through a notification or a tool result. */
export function completionContextContent(agent: RegisteredAgent, completion: AgentCompletion): string {
	return JSON.stringify({
		status: completion.status,
		taskOutcome: "not_assessed",
		agent_id: `@${agent.agentId}`,
		// Completion is an execution state. Task acceptance remains with the parent.
		// Keep a bounded head/tail preview; full output is available on demand.
		result: truncateForContext(completion.output) + maybeWriteFullOutput(agent.agentId, completion.output),
		// Only a completed persistent agent stays resident (idle) — a
		// failed follow-up is cleaned up, so no idle claim.
		idle: (agent.shouldStayResident ?? agent.persistent) && completion.status === "completed" ? true : undefined,
		// Resume entry point: sub-agent sessions live outside `pi -r`;
		// attach with `pi --session <path>`.
		session_path: completion.sessionPath ?? null,
	});
}

/** Deliver a completion notification: LLM JSON at the next safe boundary + user card. */
export function notifyCompletion(
	pi: ExtensionAPI,
	agent: RegisteredAgent,
	completion: AgentCompletion,
	delivery: { triggerTurn: boolean } = { triggerTurn: true },
): void {
	const details: NotificationDetails = {
		status: completion.status,
		taskOutcome: "not_assessed",
		agent_id: agent.agentId,
		label: agentTitle(agent.agentId, agent.label),
		model: agent.model,
		thinking: agent.thinking,
		// Card body (never enters LLM context — verified against convertToLlm).
		// The full output; the LLM-visible content below is capped (bounded preview).
		result: completion.output,
		// Persistent agent completed → resident (idle); a failed follow-up is
		// reported and cleaned up, so the idle marker must not appear there.
		idle: (agent.shouldStayResident ?? agent.persistent) && completion.status === "completed" ? true : undefined,
		usage: {
			tokens: completion.stats.tokens ?? null,
			outputTokens: completion.stats.outputTokens,
			contextTokens: completion.stats.contextTokens,
			toolUses: completion.stats.toolUses || null,
			durationMs: completion.stats.durationMs || null,
		},
		sessionPath: completion.sessionPath,
		sessionId: completion.sessionId,
	};

	pi.sendMessage(
		{
			customType: "subagent-notification",
			content: completionContextContent(agent, completion),
			display: true,
			details,
		},
		{ deliverAs: "steer", triggerTurn: delivery.triggerTurn },
	);
}
