/**
 * Tool-result presentation for a spawned child.
 *
 * SpawnCoordinator owns admission. runSpawnSession owns process lifetime.
 * This module owns only the result shown to the parent and the UI.
 * It never changes a recovery lease, registry, or tree.
 */
import { maybeWriteFullOutput, truncateForContext } from "./notification.js";
import type { AgentQuestion } from "./protocol.js";
import type { SpawnOutcome } from "./spawn-session.js";
import type { SubagentDetails } from "./types.js";

export type SpawnPresentationContext = {
	agent: {
		agentId: string;
		label: string;
		status: string;
		awaitingParent?: boolean;
		model?: string;
		thinking?: string;
	};
	profile: string;
	task: string;
	treeId: string;
	parentAgentId: string;
	controlDir: string;
	statusPath: string;
	startedAt: number;
	nested: NonNullable<SubagentDetails["nested"]>;
	resumeSessionPath?: string;
	recoveryId?: string;
	pendingQuestion?: AgentQuestion;
};

type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentDetails;
	isError?: true;
};

export type SpawnPresentation = {
	result: TextResult;
	/** Only the caller can remove a child from its parent tree. */
	treeRemoval?: "done" | "failed" | "stopped";
	/** UI receives the same background-start update as the tool response. */
	progress?: TextResult;
};

type Finished = Extract<SpawnOutcome, { kind: "finished" }>;

function baseDetails(ctx: SpawnPresentationContext): SubagentDetails {
	return {
		runtime: "profiled-subagents",
		profile: ctx.profile,
		treeId: ctx.treeId,
		parentAgentId: ctx.parentAgentId,
		agentId: ctx.agent.agentId,
		controlDir: ctx.controlDir,
		statusPath: ctx.statusPath,
	};
}

function textResult(text: string, details: SubagentDetails, isError = false): TextResult {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError ? { isError: true as const } : {}),
	};
}

export function presentBackgroundSpawn(ctx: SpawnPresentationContext): SpawnPresentation {
	const details: SubagentDetails = {
		...baseDetails(ctx),
		runInBackground: true,
		state: ctx.agent.awaitingParent ? "waiting" : ctx.agent.status,
		label: ctx.agent.label,
		model: ctx.agent.model,
		thinking: ctx.agent.thinking,
		startedAt: ctx.startedAt,
	};
	const resume = ctx.resumeSessionPath ? "Resumed" : "Started";
	const message =
		`${resume} background agent @${ctx.agent.agentId}. Completion arrives in the next tool result or notification.` +
		(ctx.recoveryId ? ` Recovery id: ${ctx.recoveryId} (list with agent_recover).` : "");
	return {
		progress: textResult(`Started ${ctx.agent.label} (background)`, details),
		result: textResult(message, details),
	};
}

export function presentFinishedSpawn(
	outcome: Finished,
	ctx: SpawnPresentationContext,
	hasParent: boolean,
): SpawnPresentation {
	const base = baseDetails(ctx);
	const { agent } = ctx;
	if (outcome.status === "completed" && agent.awaitingParent && ctx.pendingQuestion) {
		const { question, context } = ctx.pendingQuestion;
		const contextLine = context ? `\nContext: ${context}` : "";
		const message = `Agent @${agent.agentId} is waiting for your answer:\n${question}${contextLine}\n\nReply to the same agent with agent_send; its context is preserved.`;
		return {
			result: textResult(message, {
				...base,
				label: ctx.agent.label,
				state: "waiting",
				waitingForParent: true,
				question,
				context,
				sessionPath: outcome.sessionPath,
				sessionId: outcome.sessionId,
			}),
		};
	}
	if (outcome.status === "failed" || outcome.status === "stopped") {
		const message =
			outcome.status === "failed"
				? outcome.output || "Sub-agent failed."
				: outcome.stoppedByControl
					? outcome.output || "Sub-agent stopped."
					: outcome.output || "Sub-agent stopped before completing; output may be partial.";
		return {
			result: textResult(
				truncateForContext(message),
				{
					...base,
					state: agent.status,
					task: ctx.task,
					startedAt: ctx.startedAt,
					endedAt: outcome.endedAt,
					error: message,
					model: agent.model,
					thinking: agent.thinking,
					sessionPath: outcome.sessionPath,
					events: outcome.events,
					nested: ctx.nested,
				},
				true,
			),
			...(hasParent && !outcome.resident ? { treeRemoval: outcome.status } : {}),
		};
	}
	// Only successful resident agents remain addressable via agent_send.
	const formatted = truncateForContext(outcome.output) + maybeWriteFullOutput(agent.agentId, outcome.output);
	return {
		result: textResult(
			outcome.resident
				? `${formatted}\n\n(agent @${agent.agentId} is resident — send it follow-ups with agent_send)`
				: formatted,
			{
				...base,
				state: agent.awaitingParent ? "waiting" : agent.status,
				task: ctx.task,
				sessionPath: outcome.sessionPath,
				sessionId: outcome.sessionId,
				startedAt: ctx.startedAt,
				endedAt: outcome.endedAt,
				model: agent.model,
				thinking: agent.thinking,
				events: outcome.events,
				nested: ctx.nested,
			},
		),
		...(hasParent && !outcome.resident ? { treeRemoval: "done" as const } : {}),
	};
}
