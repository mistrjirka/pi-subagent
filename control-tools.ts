/** Tool registration for stop, direct messaging, and ask_parent. */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { QUESTION_STATUS_KEY } from "./event-interpret.js";
import type { MessageRouteResult } from "./message-router.js";
import type { AgentMessage, AgentQuestion } from "./protocol.js";
import type { AgentRegistry } from "./registry.js";
import { AskParentParamsSchema, SendParamsSchema, StopParamsSchema } from "./tool-params.js";
import { atId, sendView, stopView } from "./views.js";

export interface ControlToolsPorts {
	registry: Pick<
		AgentRegistry,
		| "lookup"
		| "stopAndRemove"
		| "wasDiagnosticSentRecently"
		| "recordSentDiagnostic"
		| "startSupervision"
		| "describeMessageTargets"
	>;
	agentId: string;
	hasParent: boolean;
	captureUi: (ctx: { mode: string; ui: ExtensionUIContext }) => void;
	setStatus: (key: string, value: string) => void;
	routeMessage: (message: AgentMessage, outbound: boolean, answerToQuestion?: boolean) => Promise<MessageRouteResult>;
	removeFromTree: (agentId: string) => void;
	retireRecovery: (agentId: string) => void;
	toErrorResult: (error: unknown) => {
		content: { type: "text"; text: string }[];
		details: Record<string, unknown>;
		isError: true;
	};
}

export function registerControlTools(pi: ExtensionAPI, ports: ControlToolsPorts): void {
	// ── agent_stop ───────────────────────────────────────
	pi.registerTool({
		name: "agent_stop",
		label: "Stop Agent",
		description:
			"Terminate a sub-agent: a running agent discards its work; a persistent (idle) " +
			"agent exits and is removed. The completion notification is " +
			"suppressed for deliberate stops.",
		promptSnippet: "Stop a running or idle sub-agent",
		promptGuidelines: [
			"Use agent_stop when a background agent is consuming tokens on a wrong path — stop it and respawn with a corrected prompt.",
			"Stop a persistent agent when you no longer need it — an idle agent still holds a resident process until stopped.",
		],
		parameters: StopParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate) {
			// No captureUi here: agent_stop never sends upward (no child→parent path).
			const params = raw;
			// Honour the @ reference form we teach — strip once, use everywhere
			// (lookup, stopAndRemove, details) so no @@ double prefix appears.
			const agentId = params.agent_id.replace(/^@/, "");
			const agent = ports.registry.lookup(agentId);

			if (!agent) {
				// Card title needs the id: details.agentId drives titleFrom (the
				// args key is snake_case agent_id, which titleFrom does not read).
				return {
					content: [{ type: "text", text: `agent ${params.agent_id} not found or already finished.` }],
					details: { agentId, error: `agent ${params.agent_id} not found or already finished` },
					isError: true,
				};
			}

			// Partial update first — drives the `⠋ agent_stop <label> stopping…`
			// spinner line while the child is being stopped.
			onUpdate?.({
				content: [{ type: "text", text: `Stopping ${agent.label}\u2026` }],
				details: { label: agent.label, agentId },
			});
			try {
				const stopped = await ports.registry.stopAndRemove(agentId);
				if (stopped) {
					ports.removeFromTree(agentId);
					ports.retireRecovery(agentId);
				}
				if (!stopped) {
					// Finished between lookup and removal (rare) — don't claim
					// a stop that never happened.
					const message = `agent ${params.agent_id} already finished.`;
					return {
						content: [{ type: "text", text: message }],
						details: { agentId, label: agent.label, error: message },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Stopped agent @${agentId}.` }],
					details: { agentId, label: agent.label },
				};
			} catch (err) {
				// Child died mid-stop (e.g. write-after-end): surface it as a
				// proper status line, not a bare thrown error.
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: message }],
					details: { agentId, label: agent.label, error: message },
					isError: true,
				};
			}
		},

		...stopView,
	});

	// ── agent_send ──────────────────────────────────────
	pi.registerTool({
		name: "agent_send",
		label: "Send Message",
		description: "Send a message to another agent — a sub-agent or your parent.",
		promptSnippet: "Send a message to a sub-agent or your parent",
		promptGuidelines: [
			"Send follow-up instructions to a running or idle agent with agent_send; its context is intact.",
			"When a child is waiting after ask_parent, answer that exact child id with agent_send kind=answer. Ordinary instructions do not wake a waiting child.",
			"The backend or contract owner chooses routine DTO/type names using existing code conventions; consumers read the current generated/source contract. Do not prescribe or repeatedly rename details without a verified incompatibility or a user requirement.",
			"Child messages are asynchronous snapshots, not guaranteed current state. Before correcting a child, compare the message's sent time with newer updates and the current affected files. Intervene for genuine blockers, risks, ownership conflicts, or verified defects, not reassurance or stale progress.",
			"Do not echo a child’s tool output or transient pi-lens warning. Only forward a current, verified, still-actionable diagnostic using kind=diagnostic with concrete evidence. Identical findings to the same child are deduplicated for ten minutes.",
			"Use kind=urgent for safety violations, destructive scope mistakes, or immediate cross-owner conflicts. Urgent steering is never deduplicated.",
		],
		parameters: SendParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			ports.captureUi(ctx);
			const params = raw;
			const to = params.to?.trim();
			const message = params.message?.trim();
			// Honour the @ reference form we teach — but never strip @parent
			// (the protocol layer routes on the literal value). Plain agent
			// ids get stripped once, so lookup and the card title resolve and
			// no @@ double prefix appears.
			const target = to ? (to === "@parent" ? to : to.replace(/^@/, "")) : to;
			if (!to) {
				return {
					content: [{ type: "text", text: "`to` is required." }],
					details: { error: "`to` is required." },
					isError: true,
				};
			}
			if (!message) {
				return {
					content: [{ type: "text", text: "`message` is required." }],
					details: { error: "`message` is required." },
					isError: true,
				};
			}

			if (params.kind === "diagnostic") {
				if (!params.evidence?.trim() || params.evidence.trim().length < 15) {
					return ports.toErrorResult(
						"Diagnostic steering needs current evidence: file, finding, and validation source. Do not relay unverified pi-lens output.",
					);
				}
				if (ports.registry.lookup(target) && ports.registry.wasDiagnosticSentRecently(target, message)) {
					return {
						content: [
							{ type: "text", text: `Same diagnostic already sent to ${atId(target)} within ten minutes; not resent.` },
						],
						details: { to: target, suppressedDuplicate: true },
					};
				}
			}
			onUpdate?.({
				content: [{ type: "text", text: `Sending to ${atId(target)}\u2026` }],
				details: { to: target },
			});
			const waiting = ports.registry.lookup(target)?.awaitingParent === true;
			if (waiting && params.kind !== "answer")
				return ports.toErrorResult(
					`${atId(target)} is waiting for an ask_parent answer. Use agent_send kind=answer only when explicitly resolving its question.`,
				);
			if (params.kind === "answer" && !waiting)
				return ports.toErrorResult(
					`${atId(target)} is not waiting for an ask_parent answer; use a normal instruction instead.`,
				);
			const r = await ports.routeMessage(
				{ to: target, from: ports.agentId, message, sentAt: Date.now(), ...(params.kind ? { kind: params.kind } : {}) },
				true,
				params.kind === "answer",
			);
			if (r.ok && params.kind === "diagnostic") ports.registry.recordSentDiagnostic(target, message);
			if (r.ok && !ports.hasParent && target !== "@parent" && ports.registry.lookup(target))
				ports.registry.startSupervision(target);
			if (!r.ok) {
				const reason = r.error ?? "delivery failed";
				const isUnknownChild =
					target !== "@parent" && (reason.startsWith("no such agent:") || reason.startsWith("delivery to "));
				const text = isUnknownChild
					? `${reason}

${ports.registry.describeMessageTargets(target)}`
					: reason;
				return {
					content: [{ type: "text", text }],
					details: { to: target, error: reason },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `${r.verb} to ${atId(target)}.` }],
				// Card title shows @id — target label (uniform with agent_stop).
				details: {
					to: target,
					message,
					label: ports.registry.lookup(target)?.label,
					agentId: ports.registry.lookup(target)?.agentId,
				},
			};
		},

		...sendView,
	});

	// ── ask_parent ──────────────────────────────────────
	if (ports.hasParent) {
		pi.registerTool({
			name: "ask_parent",
			label: "Ask Parent",
			description:
				"Escalate a blocker to the requested outcome when resolving it requires a material clarification, non-obvious diagnosis, or implementation decision from the immediate spawning agent. The current turn yields and this same context resumes when the parent answers.",
			promptSnippet: "Escalate a blocker that needs parent clarification, diagnosis, or a material decision",
			promptGuidelines: [
				"Use ask_parent for material ambiguity or missing information that blocks the requested outcome, or when unexpected evidence blocks that outcome and resolving it requires non-obvious diagnosis or a material decision; make routine implementation decisions, obvious local fixes, and simple direct alternatives yourself.",
				"Include the smallest safe reproduction or exact reproduction steps (or why reproduction is unsafe/impractical), the decisive evidence, what requirement or route it blocks or invalidates, and the specific decision/question for the parent.",
				"Use the escalation only to resolve that blocker; do not broaden the artifact, add adjacent behavior, or raise its engineering scale.",
				"After ask_parent succeeds, stop work and end the turn. Do not continue on an assumption. The parent will answer this same resident context with agent_send.",
			],
			parameters: AskParentParamsSchema,

			async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
				ports.captureUi(ctx);
				const params = raw;
				const question = params.question?.trim();
				const context = params.context?.trim();
				if (!question) return ports.toErrorResult("`question` is required.");
				const payload: AgentQuestion = {
					from: ports.agentId,
					question,
					...(context ? { context } : {}),
				};
				ports.setStatus(QUESTION_STATUS_KEY, JSON.stringify(payload));
				return {
					content: [
						{
							type: "text",
							text: "Question sent to your spawning agent. End this turn now and wait; do not guess or continue the blocked work. Your parent will answer with agent_send and this same context will resume.",
						},
					],
					details: { waitingForParent: true, question, ...(context ? { context } : {}) },
				};
			},
		});
	}
}
