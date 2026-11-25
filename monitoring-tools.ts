/**
 * Parent-facing monitoring tools. Wait and inspect share incremental progress.
 * Compact and full transcript cursors are separate. Neither tool stops or steers a worker.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { reportedAgentState } from "./agent-state.js";
import type { AgentActivity } from "./event-interpret.js";
import { inspectContextDiagnostics } from "./inspection-diagnostics.js";
import { excerpt, formatEditedFiles, formatMonitoringProgress } from "./monitoring-progress.js";
import { maybeWriteFullOutput, truncateForContext } from "./notification.js";
import { formatParentMessage } from "./protocol.js";
import type { AgentRegistry, AgentSettlement, AgentWaitEvent, RegisteredAgent } from "./registry.js";
import { InspectParamsSchema, WaitParamsSchema } from "./tool-params.js";
import type { IncrementalMonitoringTranscript } from "./transcript.js";
import { atId } from "./views.js";
import { registerWaitInput } from "./wait-input.js";
import { DEFAULT_WAIT_TIMEOUT_SECONDS, resolveWaitTimeoutSeconds } from "./wait-policy.js";

type ErrorToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError: true;
};

export type MonitoringPorts = {
	registry: AgentRegistry;
	captureUi: (ctx: { mode: string; ui: ExtensionUIContext }) => void;
	unreadTranscript: (
		agent: Pick<RegisteredAgent, "agentId" | "sessionPath" | "getEntries">,
		options: { maxMessages: number; maxChars: number; perMessageChars: number; detail?: "recent" | "full" },
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
		description: `Wait for a direct child to settle or ask a question, or receive any child message. Accepted user input also releases the wait. Default ${DEFAULT_WAIT_TIMEOUT_SECONDS} seconds; expiry returns compact progress without stopping the child. Completion reports turn settlement, not acceptance of the task.`,
		promptSnippet: "Wait for a background or resumed child to settle",
		promptGuidelines: [
			"Use agent_wait when a child's result becomes the next dependency instead of shell sleep or polling. This applies to subagents, not ordinary external processes with process/job wait mechanisms. Use completion results already delivered rather than fetching them again.",
			"For supervision, keep a 150-second wait window. Compare new evidence with the assigned scope and last correction to check whether the child is making real progress. Inspect or steer for a concrete blocker, scope drift, repeated failure or necessary coordination; stop when needed. On timeout, agent_wait reports compact progress, not a transcript. Use agent_inspect only to resolve a problem or decision. If progress remains aligned, wait again without reassurance messages, document updates, or repeated audits. A timeout or long-running command alone is not a stall.",
			`Default wait: ${DEFAULT_WAIT_TIMEOUT_SECONDS} seconds. timeout_seconds: 0 returns an immediate live snapshot.`,
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
			const wait = waitInput.begin(ctx, signal);
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
				const progress = live.getMonitoringProgress?.();
				const window = timeoutSeconds === 0 ? "Status snapshot" : `Wait window of ${timeoutSeconds}s expired`;
				return {
					content: [
						{
							type: "text",
							text:
								`${window}; ${atId(agentId)} is still ${reportedAgentState(live)}. Latest activity: ${activitySummary(activity)}.` +
								`\n${formatMonitoringProgress(progress)}`,
						},
					],
					details: {
						agentId,
						state: reportedAgentState(live),
						timedOut: timeoutSeconds !== 0,
						timeoutSeconds,
						activity,
						progress,
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
				const sender = registry.lookup(message.from);
				const pending = sender?.getMonitoringProgress?.(false);
				const progress =
					pending && (pending.editedFiles.length || pending.errors) ? sender?.getMonitoringProgress?.() : undefined;
				return {
					content: [
						{
							type: "text",
							text: `Message from ${atId(message.from)} during agent_wait for ${atId(agentId)}:\n${formatParentMessage(message)}\n\nThe child is still running.${progress ? "\n" + formatMonitoringProgress(progress, false) : ""}`,
						},
					],
					details: {
						agentId,
						state: "message",
						from: message.from,
						message: message.message,
						wokenByMessage: true,
						...(progress ? { progress } : {}),
					},
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
							text: `Agent ${atId(agentId)} is waiting for your answer:\n${settlement.question.question}${contextLine}\n\nReply with agent_send kind=answer; its context is preserved.`,
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
			registry.acknowledgeSettlement(agentId, settlement);
			const progress = registry.lookup(agentId)?.getMonitoringProgress?.() ?? completion.progress;
			return {
				content: [
					{
						type: "text",
						text:
							(output || `Agent ${atId(agentId)} ${completion.status}.`) +
							(progress ? "\n\n" + formatEditedFiles(progress) : ""),
					},
				],
				details: {
					agentId,
					state: completion.status,
					taskOutcome: "not_assessed",
					error: completion.status === "completed" ? undefined : completion.output || completion.status,
					sessionPath: completion.sessionPath,
					sessionId: completion.sessionId,
					endedAt: Date.now(),
					...(progress ? { progress } : {}),
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
			"Read a direct child's state, tracked edited files and compact recent evidence (default). Set mode=full for detailed evidence or mode=diagnostics for persisted context metadata. Recent previews never acknowledge final delivery. Does not stop or steer the child.",
		promptSnippet: "Inspect recent child evidence or a full unread transcript page",
		promptGuidelines: [
			"Use agent_inspect when supervision needs more evidence than the compact wait status. Recent mode skips thinking and echoed instructions, shortens tool arguments and results, and starts with the newest unread evidence.",
			"Use mode=full only when the compact recent evidence is insufficient. It has a separate unread transcript page cursor, so compact inspection never consumes full evidence.",
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
			const full = params.mode === "full";
			const maxMessages = params.max_messages ?? (full ? 12 : 8);
			if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 30) {
				return toErrorResult("`max_messages` must be an integer from 1 to 30.");
			}
			if (!agent && !settled) return toErrorResult(`Unknown direct child ${atId(agentId)}.`);
			if (params.mode === "diagnostics") {
				return {
					content: [
						{ type: "text", text: inspectContextDiagnostics(agent?.sessionPath ?? settled?.completion.sessionPath) },
					],
					details: { agentId, mode: "diagnostics", taskOutcome: "not_assessed" },
				};
			}
			if (!agent) {
				// Archived and resident recent previews have the same budget and delivery semantics.
				if (!settled) return toErrorResult(`Unknown direct child ${atId(agentId)}.`);
				const completion = settled.completion;
				const transcript = completion.sessionPath
					? await unreadTranscript(
							{ agentId, sessionPath: completion.sessionPath },
							{
								maxMessages,
								maxChars: full ? 20_000 : 2_200,
								perMessageChars: full ? 2_000 : 420,
								detail: full ? "full" : "recent",
							},
							!full,
						)
					: undefined;
				const preview =
					transcript?.text ||
					(full
						? truncateForContext(completion.output) + maybeWriteFullOutput(agentId, completion.output)
						: excerpt(completion.output, 1500));
				const deliveredWholeResult =
					full &&
					!settled.waitingForParent &&
					completion.output.trim() &&
					(transcript
						? !transcript.hasMore && transcript.text.includes(completion.output)
						: preview === completion.output);
				if (deliveredWholeResult) registry.acknowledgeSettlement(agentId, settled);
				const text =
					`${atId(agentId)} — ${completion.status}; process exited.\n${formatEditedFiles(completion.progress)}\n\n${full ? "Unread full transcript" : "Recent evidence"}:\n${preview}` +
					(full
						? transcript?.hasMore
							? "\nMore full history available."
							: ""
						: "\nPreview only. Use agent_wait for final delivery or mode=full for details.");
				return {
					content: [{ type: "text", text: full ? text : excerpt(text, 2200) }],
					details: {
						agentId,
						state: completion.status,
						archived: true,
						taskOutcome: "not_assessed",
						sessionPath: completion.sessionPath,
						transcript,
					},
				};
			}
			const progress = agent.getMonitoringProgress?.(false);
			const transcript = await unreadTranscript(
				agent,
				{
					maxMessages,
					maxChars: full ? 20_000 : 2_200,
					perMessageChars: full ? 2_000 : 420,
					detail: full ? "full" : "recent",
				},
				!full,
			);
			// A paginated activity read is not an acknowledgement of the final result.
			// Cancel only when this page actually contains the full settled output.
			if (
				full &&
				settled &&
				!settled.waitingForParent &&
				!transcript.hasMore &&
				settled.completion.output.trim() &&
				transcript.text.includes(settled.completion.output)
			) {
				registry.acknowledgeSettlement(agentId, settled);
			}
			const activity = agent.getLatestActivity?.();
			const elapsedMs = agent.startedAt ? Date.now() - agent.startedAt : undefined;
			if (!hasParent) registry.touchSupervision(agentId);
			return {
				content: [
					{
						type: "text",
						text: (full ? (value: string) => value : (value: string) => excerpt(value, 2200))(
							`${atId(agentId)} — ${reportedAgentState(agent)}; latest activity: ${activitySummary(activity)}\n${formatMonitoringProgress(progress, false)}\n\n${full ? "Unread full transcript" : "Recent evidence (newest first)"} (${transcript.returnedMessages} shown; ${transcript.source}):\n${transcript.text}` +
								(full && transcript.hasMore
									? "\nMore full history available."
									: !full
										? "\nUse mode=full for detailed history."
										: ""),
						),
					},
				],
				details: {
					agentId,
					label: agent.label,
					progress,
					state: reportedAgentState(agent),
					taskOutcome: "not_assessed",
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
