/**
 * Parent-facing monitoring tools. Both tools share one unread transcript cursor
 * per child, owned by the parent extension. They never stop or steer a worker.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { reportedAgentState } from "./agent-state.js";
import type { AgentActivity } from "./event-interpret.js";
import { maybeWriteFullOutput, truncateForContext } from "./notification.js";
import { formatParentMessage } from "./protocol.js";
import type { AgentRegistry, AgentSettlement, AgentWaitEvent, RegisteredAgent } from "./registry.js";
import { InspectParamsSchema, WaitParamsSchema } from "./tool-params.js";
import type { IncrementalMonitoringTranscript } from "./transcript.js";
import { atId } from "./views.js";
import { registerWaitInput } from "./wait-input.js";
import { resolveWaitTimeoutSeconds } from "./wait-policy.js";

type ErrorToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError: true;
};

export type MonitoringPorts = {
	registry: AgentRegistry;
	captureUi: (ctx: { mode: string; ui: ExtensionUIContext }) => void;
	unreadTranscript: (
		agent: RegisteredAgent,
		options: { maxMessages: number; maxChars: number; perMessageChars: number },
		newestFirst?: boolean,
	) => Promise<IncrementalMonitoringTranscript>;
	activitySummary: (activity: AgentActivity | undefined) => string;
	toErrorResult: (error: unknown) => ErrorToolResult;
	hasParent: boolean;
};

export function registerMonitoringTools(pi: ExtensionAPI, ports: MonitoringPorts): void {
	const { registry, captureUi, unreadTranscript, activitySummary, toErrorResult, hasParent } = ports;
	const waitInput = registerWaitInput(pi);

	// ── agent_wait ───────────────────────────────────────
	pi.registerTool({
		name: "agent_wait",
		label: "Wait for Agent",
		description:
			"Wait for a direct child to settle, fail/stop, ask its parent a question, or receive any child message to @parent. Child messages wake the wait immediately. Accepted user steering also releases the wait when supported by the host. timeout_seconds limits this call; expiry shows newest progress. None stops the child. Default 180 seconds.",
		promptSnippet: "Wait for a background or resumed child to settle",
		promptGuidelines: [
			"Use agent_wait when a background child's result becomes the next dependency instead of shell sleep or polling. This applies to subagents, not ordinary external processes with process/job wait mechanisms. Use completion results already delivered rather than fetching them again.",
			"For supervision, keep a 150-second wait window. Compare new evidence with the assigned scope and last correction. On timeout, agent_wait shows newest unread progress while agent_inspect pages through older unread history. Inspect older messages only to resolve a problem or decision. If progress remains aligned, wait again without reassurance messages, document updates, or repeated audits. The two tools avoid repeating already shown transcript entries.",
			"If timeout_seconds is omitted, agent_wait uses a 180-second supervision window. timeout_seconds: 0 returns an immediate live snapshot.",
			"If agent_wait returns an ask_parent question, answer that same child with agent_send kind=answer. Wait again only when its resumed result is needed.",
			"If agent_wait returns an ordinary message from any child, handle it immediately. The child remains running. Reply with agent_send if needed, then resume supervision.",
			"If agent_wait ends because new user input arrived, handle that input before waiting again. Child agents continue in the background.",
		],
		parameters: WaitParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw;
			const rawId = params.agent_id?.trim();
			const agentId = rawId?.replace(/^@/, "");
			if (!agentId) return toErrorResult("`agent_id` is required.");
			const requestedTimeoutSeconds = params.timeout_seconds;
			if (
				requestedTimeoutSeconds !== undefined &&
				(!Number.isFinite(requestedTimeoutSeconds) || requestedTimeoutSeconds < 0)
			) {
				return toErrorResult("`timeout_seconds` must be a finite non-negative number.");
			}
			const timeoutSeconds = resolveWaitTimeoutSeconds(requestedTimeoutSeconds);
			const timeoutMs = timeoutSeconds * 1000;
			const waitLabel = `up to ${timeoutSeconds}s`;
			const wait = waitInput.begin(ctx.sessionManager.getSessionId(), signal);
			let settlement: AgentSettlement | AgentWaitEvent | null | undefined;
			try {
				onUpdate?.({
					content: [{ type: "text", text: `Waiting for ${atId(agentId)} (${waitLabel})…` }],
					details: { agentId, timeoutSeconds },
				});
				settlement = await registry.waitForSettlement(agentId, wait.signal, timeoutMs, true);
			} catch (error) {
				if (wait.interruptedByUser && !signal?.aborted) {
					const live = registry.lookup(agentId);
					const state = live
						? reportedAgentState(live)
						: (registry.peekSettlement(agentId)?.completion.status ?? "unknown");
					return {
						content: [
							{
								type: "text",
								text: `Waiting for ${atId(agentId)} ended because new user input arrived. Current state: ${state}. Running child agents continue in the background. Handle the new input before waiting again.`,
							},
						],
						details: { agentId, state, interruptedByUser: true },
					};
				}
				return toErrorResult(error);
			} finally {
				wait.dispose();
			}
			if (settlement === null) {
				const live = registry.lookup(agentId);
				if (!live) return toErrorResult(`Agent ${atId(agentId)} stopped being waitable while the wait window expired.`);
				const activity = live.getLatestActivity?.();
				const elapsedMs = live.startedAt ? Date.now() - live.startedAt : undefined;
				const transcript = await unreadTranscript(
					live,
					{
						maxMessages: 8,
						maxChars: 8_000,
						perMessageChars: 1_500,
					},
					true,
				);
				const window = timeoutSeconds === 0 ? "Status snapshot" : `Wait window of ${timeoutSeconds}s expired`;
				return {
					content: [
						{
							type: "text",
							text:
								`${window}; ${atId(agentId)} is still ${reportedAgentState(live)}. Latest activity: ${activitySummary(activity)}. ` +
								"The wait window did not stop the agent. SUPERVISION CHECK REQUIRED: compare new evidence with the assigned scope and last correction. A timeout or long-running command alone is not a stall. " +
								"If progress remains aligned, wait again without reassurance messages, document updates, or repeated audits. Inspect or steer with agent_send for a concrete blocker, scope drift, repeated failure, or necessary coordination. Stop the child when needed." +
								`\n\nNewest progress (${transcript.returnedMessages} messages, newest first; ${transcript.source}):\n${transcript.text}\n\nFor older unread history, use agent_inspect when needed.`,
						},
					],
					details: {
						agentId,
						state: reportedAgentState(live),
						timedOut: timeoutSeconds !== 0,
						timeoutSeconds,
						activity,
						transcript,
						elapsedMs,
					},
				};
			}
			if (!settlement) return toErrorResult(`Unknown or no-longer-waitable direct child ${atId(agentId)}.`);
			if ("kind" in settlement && settlement.kind === "other_wait") {
				return {
					content: [
						{
							type: "text",
							text: `Another concurrent agent_wait returned this ${settlement.reason}. See its tool result for the details.`,
						},
					],
					details: { agentId, state: "other_wait", reason: settlement.reason },
				};
			}
			if ("message" in settlement) {
				const message = settlement.message;
				return {
					content: [
						{
							type: "text",
							text: `Message from ${atId(message.from)} during agent_wait for ${atId(agentId)}:\n${formatParentMessage(message)}\n\nThe wait ended immediately; the child is still running. Reply with agent_send if needed, then resume supervision.`,
						},
					],
					details: { agentId, state: "message", from: message.from, message: message.message, wokenByMessage: true },
				};
			}
			const completion = settlement.completion;
			if (settlement.deliveredInToolResult) {
				return {
					content: [
						{
							type: "text",
							text: `Agent ${atId(agentId)} ${completion.status}; its result was already included in a prior tool result.`,
						},
					],
					details: { agentId, state: completion.status, alreadyDelivered: true },
				};
			}
			if (settlement.waitingForParent && settlement.question) {
				if (settlement.questionAnnounced)
					return {
						content: [
							{
								type: "text",
								text: `Agent ${atId(agentId)} is waiting for an answer. Its question has already been queued to the parent as a priority notification; do not repeat it. Reply with agent_send kind=answer.`,
							},
						],
						details: { agentId, state: "waiting", waitingForParent: true, questionAnnounced: true },
					};
				const contextLine = settlement.question.context ? `\nContext: ${settlement.question.context}` : "";
				return {
					content: [
						{
							type: "text",
							text: `Agent ${atId(agentId)} is waiting for your answer:\n${settlement.question.question}${contextLine}\n\nReply with agent_send; its context is preserved.`,
						},
					],
					details: {
						agentId,
						state: "waiting",
						waitingForParent: true,
						question: settlement.question.question,
						context: settlement.question.context,
						sessionPath: completion.sessionPath,
						sessionId: completion.sessionId,
					},
				};
			}
			const output = truncateForContext(completion.output) + maybeWriteFullOutput(agentId, completion.output);
			return {
				content: [{ type: "text", text: output || `Agent ${atId(agentId)} ${completion.status}.` }],
				details: {
					agentId,
					state: completion.status,
					error: completion.status === "completed" ? undefined : completion.output || completion.status,
					sessionPath: completion.sessionPath,
					sessionId: completion.sessionId,
					endedAt: Date.now(),
				},
				...(completion.status === "completed" ? {} : { isError: true }),
			};
		},
	});

	// ── agent_inspect ────────────────────────────────────
	pi.registerTool({
		name: "agent_inspect",
		label: "Inspect Agent",
		description:
			"Read a direct child's current state and the next transcript messages not already returned by agent_wait/agent_inspect. This advances only the parent's transcript cursor; it does not stop or steer the child.",
		promptSnippet: "Read a running child's next unread transcript page",
		promptGuidelines: [
			"Use agent_inspect when supervision needs more evidence than the latest activity marker. It advances the same parent-side transcript cursor as agent_wait but does not change the child.",
			"max_messages is a page size, not a tail size: unread messages beyond the page stay queued for the next agent_wait/agent_inspect call.",
		],
		parameters: InspectParamsSchema,

		async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
			captureUi(ctx);
			const params = raw;
			const rawId = params.agent_id?.trim();
			const agentId = rawId?.replace(/^@/, "");
			if (!agentId) return toErrorResult("`agent_id` is required.");
			const agent = registry.lookup(agentId);
			const settled = registry.peekSettlement(agentId);
			if (!agent) {
				if (!settled) return toErrorResult(`Unknown direct child ${atId(agentId)}.`);
				registry.consumeSettlement(agentId, settled);
				return {
					content: [
						{
							type: "text",
							text: `${atId(agentId)} — ${settled.completion.status}; process exited.\n\n${truncateForContext(settled.completion.output)}`,
						},
					],
					details: {
						agentId,
						state: settled.completion.status,
						archived: true,
						sessionPath: settled.completion.sessionPath,
					},
				};
			}
			const maxMessages = params.max_messages ?? 12;
			if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 30) {
				return toErrorResult("`max_messages` must be an integer from 1 to 30.");
			}
			const transcript = await unreadTranscript(agent, {
				maxMessages,
				maxChars: 20_000,
				perMessageChars: 2_000,
			});
			// A paginated activity read is not an acknowledgement of the final result.
			// Cancel only when this page actually contains the full settled output.
			if (
				settled &&
				!settled.waitingForParent &&
				!transcript.hasMore &&
				settled.completion.output.trim() &&
				transcript.text.includes(settled.completion.output)
			) {
				registry.consumeSettlement(agentId, settled);
			}
			const activity = agent.getLatestActivity?.();
			const elapsedMs = agent.startedAt ? Date.now() - agent.startedAt : undefined;
			if (!hasParent) registry.touchSupervision(agentId);
			return {
				content: [
					{
						type: "text",
						text: `${atId(agentId)} — ${reportedAgentState(agent)}; latest activity: ${activitySummary(activity)}\n\nUnread transcript (${transcript.returnedMessages} shown${transcript.hasMore ? `, ${transcript.remainingMessagesExact === false ? "at least " : ""}${transcript.remainingMessages} still unread` : ""}; ${transcript.source}):\n${transcript.text}`,
					},
				],
				details: {
					agentId,
					label: agent.label,
					state: reportedAgentState(agent),
					activity,
					transcript: transcript.text,
					transcriptSource: transcript.source,
					error: transcript.rpcError,
					returnedMessages: transcript.returnedMessages,
					remainingMessages: transcript.remainingMessages,
					elapsedMs,
					sessionPath: agent.sessionPath,
				},
			};
		},
	});
}
