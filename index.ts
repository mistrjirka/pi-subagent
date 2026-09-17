/**
 * pi-subagent — spawn isolated sub‑agent pi instances + in-tree messaging.
 *
 * Architecture:
 *   index.ts          — tool registration (agent_spawn / agent_wait / agent_inspect / agent_stop / agent_send) + routing glue
 *   protocol.ts       — pure JSONL protocol layer + in-tree routing (tested)
 *   rpc-client.ts     — stateful thin JSONL client (spawn + transport)
 *   event-interpret.ts— raw RpcEvent → AgentEvent adapter (pure, tested)
 *   agent-process.ts  — AgentProcess: one resident `pi --mode rpc` child, semantic API
 *   registry.ts       — AgentRegistry: lifecycle + completion policy + routing (tested)
 *   model.ts          — model-spec → ResolvedModel (testable)
 *   name-gen.ts       — short human-readable agent ids (tested)
 *   spawn-session.ts  — spawn lifecycle (fg/bg/persistent) + outcome classification (tested)
 *   nested-fold.ts    — foreground-card nested-subtree meta counters (tested)
 *   tree-display.ts   — subtree display anchor: fold / forward / widget (显示面统一规则)
 *   notification.ts   — completion-notification payloads (notifyCompletion)
 *   types.ts          — shared tool-output / notification shapes
 *   views.ts          — tool card views (single source for the three cards)
 *   card.ts           — notification card wrappers (via pi-ui)
 *   render.ts         — notification card renderer (message surface)
 *   widget.ts         — Agents status widget
 *
 * Every sub‑agent is a resident `pi --mode rpc` child with a persisted
 * session. Foreground agent_spawn calls block until completion; background
 * calls return an agent_id immediately and deliver a completion notification
 * (`customType: "subagent-notification"`, deliverAs "followUp") carrying the
 * final output. agent_send messages flow along tree edges (parent↔child);
 * persistent agents stay resident (idle, zero token) and can be woken by a
 * message.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentProcess } from "./agent-process.js";
import {
	type AgentActivity,
	type AgentTreeEvent,
	MSG_STATUS_KEY,
	QUESTION_STATUS_KEY,
	TREE_STATUS_KEY,
} from "./event-interpret.js";
import { ExternalControlBridge } from "./external-control.js";
import { createLiveChannels } from "./live-output.js";
import { resolveModel } from "./model.js";
import { maybeWriteFullOutput, notifyCompletion, truncateForContext } from "./notification.js";
import {
	discoverAgentProfiles,
	formatAvailableProfiles,
	parseAllowedSubagentsEnv,
	resolveAgentProfile,
} from "./profiles.js";
import { type AgentMessage, type AgentQuestion, formatFrom } from "./protocol.js";
import { AgentRegistry, type AgentSettlement, type WidgetSurface } from "./registry.js";
import { renderNotification } from "./render.js";
import { runSpawnSession, type SpawnOutcome } from "./spawn-session.js";
import { formatTranscript } from "./transcript.js";
import { createSubtreeDisplay } from "./tree-display.js";
import type { SubagentDetails } from "./types.js";
import { atId, sendView, spawnView, stopView } from "./views.js";
import { resolveWaitTimeoutSeconds } from "./wait-policy.js";
import { AgentWidget } from "./widget.js";

// ─── Running background agents registry ─────────────────────

/** Expand a leading `~` (pi's own expandTildePath only normalizes). */
function expandTilde(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Agent sessions directory: `<agentDir>/subagent-sessions` by default
 * (agentDir honors PI_CODING_AGENT_DIR like pi itself), overridable via
 * PI_SUBAGENT_SESSION_DIR. Kept outside pi's standard session tree so
 * `pi -r` stays clean; resume goes through the main session via the
 * session path on the notification / tool result.
 */
function resolveSubagentSessionDir(): string {
	const override = process.env.PI_SUBAGENT_SESSION_DIR;
	if (override) return expandTilde(override);
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(expandTilde(agentDir), "subagent-sessions");
}

const SUBAGENT_SESSION_DIR = resolveSubagentSessionDir();

// ─── In-tree identity ──────────────────────────────────────

/** This process's agent id ("" = root session). Injected by the parent at spawn. */
const MY_AGENT_ID = process.env.PI_SUBAGENT_AGENT_ID ?? "";
/** I am a child agent when an identity was injected (root children get "a1"…). */
const HAS_PARENT = MY_AGENT_ID !== "";
/** One stable id for this root Pi process and every descendant it spawns. */
const AGENT_TREE_ID = process.env.PI_SUBAGENT_TREE_ID ?? randomUUID();
/** Stable delegation capability inherited from the profile used to spawn this process. */
const CURRENT_AGENT_PROFILE = process.env.PI_SUBAGENT_PROFILE ?? "";
const ALLOWED_SUBAGENTS = parseAllowedSubagentsEnv(process.env.PI_SUBAGENT_ALLOWED_SUBAGENTS);

/** TUI-only background-agent status widget (created lazily, tui mode only). */
let widget: AgentWidget | null = null;

/**
 * Lazily-captured UI handle for the child→parent channel (extension_ui_request /
 * setStatus under the reserved key). Tool executes refresh it every call —
 * a sub-agent that spawned children has run its own execute first, so the
 * ref is always warm before any inbound @parent message needs to go up.
 */
let uiRef: { setStatus(key: string, text: string | undefined): void } | undefined;

function ensureWidget(ctx: { mode: string; ui: unknown }): AgentWidget | null {
	captureUi(ctx);
	if (widget) return widget;
	if (ctx.mode !== "tui") return null;
	// biome-ignore lint/suspicious/noExplicitAny: ExtensionUIContext shape from pi
	widget = new AgentWidget(ctx.ui as any);
	return widget;
}

/**
 * Refresh the child→parent handle from any tool execute. Every execute runs
 * with a UI context (rpc children too — their setStatus emits the
 * extension_ui_request event stream the parent consumes), and a sub-agent
 * must have run its own execute before it can spawn children, so the ref
 * is always warm before any inbound @parent message needs to go up.
 */
function captureUi(ctx: { mode: string; ui: unknown }): void {
	uiRef = ctx.ui as { setStatus(key: string, text: string | undefined): void };
}

/** Narrow TUI adapter: AgentWidget → WidgetSurface (registry seam). */
function widgetSurface(): WidgetSurface | null {
	const w = widget;
	if (!w) return null;
	return {
		add: (agent, status) => w.add(agent as AgentProcess, status),
		remove: (agentId, result) => w.remove(agentId, result),
		setStatus: (agentId, status) => w.setStatus(agentId, status),
		dispose: () => w.dispose(),
	};
}

// ─── Tool parameter schemas ──────────────────────────────

/**
 * Tree telemetry (nested agents): a sub-agent's own spawns are invisible to
 * the user — the only TUI is the root session's. Every node reports ALL its
 * spawns upward (foreground and background alike) over the same setStatus
 * transport as @parent messages; intermediate nodes forward verbatim
 * (depth + 1). Consumption is decided at the anchor boundary — the execute
 * that owns the visible surface:
 *   • root + background child → widget rows (indent = depth)
 *   • root + foreground child → folded into that card's nested meta counters
 * A foreground card's subtree therefore never reaches the widget, and a
 * background row's subtree never leaks into a card — one subtree, one
 * surface (SPEC: 显示面统一规则).
 */
function createTreeTelemetry(hasParent: boolean) {
	/** Ids reported as added — guards activity/remove so unknown ids never
	 *  emit telemetry. */
	const tracked = new Set<string>();
	const report = (event: AgentTreeEvent) => uiRef?.setStatus(TREE_STATUS_KEY, JSON.stringify(event));
	return {
		report,
		add(agent: { agentId: string; label: string; startedAt: number }, status: "running" | "idle"): void {
			if (!hasParent) return;
			tracked.add(agent.agentId);
			// `parent` is my own id: I am the direct parent of every child I spawn.
			// Forwarding nodes pass the event through verbatim, so the link stays
			// anchored at the real parent however deep the chain runs.
			report({
				op: "add",
				id: agent.agentId,
				label: agent.label,
				startedAt: agent.startedAt,
				depth: 1,
				status,
				parent: MY_AGENT_ID,
			});
		},
		activity(agent: { agentId: string; getLatestActivity(): AgentActivity | undefined }): void {
			if (!tracked.has(agent.agentId)) return;
			const activity = agent.getLatestActivity();
			if (!activity) return;
			report({ op: "activity", id: agent.agentId, activity });
		},
		remove(agentId: string, status: "done" | "failed" | "stopped"): void {
			if (!tracked.delete(agentId)) return;
			report({ op: "remove", id: agentId, status });
		},
	};
}

/** agent_spawn tool params. Execution policy comes from the named profile/settings, not the call. */
interface SpawnParams {
	agent: string;
	prompt: string;
	label?: string;
	run_in_background?: boolean;
	persistent?: boolean;
}

/** agent_wait tool params. */
interface WaitParams {
	agent_id: string;
	timeout_seconds?: number;
}

interface InspectParams {
	agent_id: string;
	max_messages?: number;
}

/** agent_stop tool params. */
interface StopParams {
	agent_id: string;
}

/** agent_send tool params. */
interface SendParams {
	to: string;
	message: string;
}

interface AskParentParams {
	question: string;
	context?: string;
}

const SpawnAgentField = Type.String({
	description: "Exact name of a configured agent profile from ~/.pi/agent/agents or .pi/agents.",
});
const SpawnPromptField = Type.String({
	description: "The delegated task. Role instructions come from the agent profile and do not need to be repeated here.",
});
const SpawnLabelField = Type.Optional(
	Type.String({ description: "Optional short UI label. Defaults to the agent profile name." }),
);

/**
 * The model-facing spawn API intentionally has no model/thinking/tools/timeout
 * parameters. Those belong to settings/profile configuration; execution has no
 * framework-imposed task cap. Nested delegation is controlled by each profile's
 * allowed_subagents list.
 */
export function canDelegate(hasParent: boolean, allowedSubagents: readonly string[]): boolean {
	return !hasParent || allowedSubagents.length > 0;
}

export function buildSpawnParamsSchema(hasParent: boolean): ReturnType<typeof Type.Object> {
	return Type.Object({
		agent: SpawnAgentField,
		prompt: SpawnPromptField,
		label: SpawnLabelField,
		persistent: Type.Optional(
			Type.Boolean({
				description:
					"If true, keep the child resident after it completes so the same context can be resumed with agent_send.",
			}),
		),
		...(hasParent
			? {}
			: {
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"Root-only execution choice. true returns immediately; false/omitted waits in foreground. Nested agents are always foreground.",
						}),
					),
				}),
	});
}

const SpawnParamsSchema = buildSpawnParamsSchema(HAS_PARENT);

const WaitParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The direct child id to wait for (e.g. "@max").' }),
	timeout_seconds: Type.Optional(
		Type.Number({
			minimum: 0,
			description:
				"Optional wait-window timeout in seconds. Expiry returns a live status snapshot and never stops the child. Omit for the default 180-second supervision window; 0 returns an immediate snapshot.",
		}),
	),
});

const InspectParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The direct child id to inspect (e.g. "@max").' }),
	max_messages: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 30,
			description: "Number of recent child conversation messages to include. Defaults to 12.",
		}),
	),
});

const StopParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The agent id to stop (e.g. "@max").' }),
});

const SendParamsSchema = Type.Object({
	to: Type.String({
		description:
			'The agent id from agent_spawn (e.g. "@max" — a spawn result or completion ' +
			'notification carries it), or "@parent" to message the session that spawned you.',
	}),
	message: Type.String({ description: "The message text." }),
});

const AskParentParamsSchema = Type.Object({
	question: Type.String({
		description: "The specific material question that blocks safe progress.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Brief evidence/context explaining why the answer cannot safely be inferred.",
		}),
	),
});

// ─── Helpers ─────────────────────────────────────────────────

const SUPERVISION_REMINDER_MS = 180_000;

function activitySummary(activity: AgentActivity | undefined): string {
	if (!activity) return "no recent activity reported";
	if (activity.kind === "thinking") return "thinking";
	if (activity.kind === "tool") return `${activity.name}${activity.args ? ` — ${activity.args}` : ""}`;
	const text = activity.text.replace(/\s+/g, " ").trim();
	return text ? `writing — ${Array.from(text).slice(-180).join("")}` : "writing";
}

function toErrorResult(err: unknown): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
		isError: true,
	};
}

/** Spawn-failure tool result: isError + the reason (LLM + user card share it). */
function spawnErrorResult(
	started: { error: string },
	extra: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	return {
		content: [{ type: "text", text: started.error }],
		details: { error: started.error, ...extra },
		isError: true as const,
	};
}

/**
 * Route one in-tree message through the tree (per-hop O(1) against my
 * direct children). Shared by the agent_send tool (outbound: the caller
 * gets a synchronous result) and the inbound handler (child→parent: no
 * return path, so errors are delivered back to the sender as messages).
 *
 *   direct child → rpc prompt + steer (wakes idle, queues on running)
 *   "@parent"   → the parent injects it into its LLM (or mine, inbound)
 *   unknown     → explicit error (routing is the LLM's job, hop by hop);
 *                 on the inbound path the sender is told best-effort
 */
async function handleMessage(
	pi: ExtensionAPI,
	registry: AgentRegistry,
	msg: AgentMessage,
	outbound: boolean,
): Promise<{ ok: boolean; verb?: string; error?: string }> {
	const d = registry.route(msg);
	switch (d.kind) {
		case "child": {
			// Point-to-point delivery to a direct child. Cross-level coordination
			// is the LLM's job: it addresses only ids it knows, hop by hop.
			const text = `${formatFrom(d.message.from)}${d.message.message}`;
			const ok = await registry.deliver(d.childId, text);
			return ok ? { ok: true, verb: "delivered" } : { ok: false, error: `delivery to ${d.childId} failed` };
		}
		case "parent": {
			if (outbound) {
				// I am addressing my own parent — point-to-point up; the parent's
				// extension injects it into its LLM session.
				uiRef?.setStatus(MSG_STATUS_KEY, JSON.stringify(d.message));
				return { ok: true, verb: "delivered" };
			}
			// My child addressed "@parent" (= me): inject into my session.
			pi.sendMessage(
				{
					customType: "subagent-message",
					content: `${formatFrom(d.message.from)}${d.message.message}`,
					display: true,
					details: { from: d.message.from, message: d.message.message },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			return { ok: true, verb: "delivered" };
		}
		case "error": {
			if (!outbound && msg.from) {
				// Inbound path, no return channel: tell the sender (best-effort).
				void registry.deliver(msg.from, `[pi-subagent] agent_send to ${msg.to} failed: ${d.reason}`);
			}
			return { ok: false, error: d.reason };
		}
	}
}

// ─── Default export (pi extension entry) ───────────────────────

export default function (pi: ExtensionAPI) {
	// pi's agent-core drops the execute() isError flag when a tool returns
	// normally (bash gets its error background by throwing instead) — see
	// agent-core executePreparedToolCall. Re-attach it for our tools by
	// marking every error path in `details.error`; the handler restores
	// isError so failed calls render with toolErrorBg like bash, while
	// keeping the details (status line) intact.
	pi.on("tool_result", async (event) => {
		if (
			event.toolName !== "agent_spawn" &&
			event.toolName !== "agent_stop" &&
			event.toolName !== "agent_send" &&
			event.toolName !== "ask_parent"
		) {
			return undefined;
		}
		const details = event.details as { error?: unknown } | undefined;
		if (!details || details.error === undefined) return undefined;
		return { isError: true };
	});

	// One registry per session: owns the running-agent bookkeeping, the
	// completion policy (notify unless user-stopped; cleanup on every path),
	// and the in-tree routing (direct children only — per-hop O(1)).
	const registry = new AgentRegistry({
		notify: (agent, completion) => notifyCompletion(pi, agent, completion),
		...(!HAS_PARENT
			? {
					remind: async (agent: Parameters<typeof notifyCompletion>[1], unsupervisedMs: number) => {
						const minutes = Math.max(1, Math.round(unsupervisedMs / 60_000));
						const activity = activitySummary(agent.getLatestActivity?.());
						const messages = agent.getMessages ? await agent.getMessages().catch(() => []) : [];
						const transcript = formatTranscript(messages, { maxMessages: 4, maxChars: 4_000, perMessageChars: 1_000 });
						pi.sendMessage(
							{
								customType: "subagent-supervision",
								content:
									`Subagent @${agent.agentId} has been running unsupervised for about ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
									`Latest activity: ${activity}. Check whether it is making sensible progress. ` +
									"If it is fine, continue supervision with agent_wait (normally a 150-second window); otherwise steer it with agent_send or stop it. Do not use shell sleep or polling." +
									`\n\nRecent transcript:\n${transcript}`,
								display: true,
								details: {
									agentId: agent.agentId,
									label: agent.label,
									state: agent.status ?? "running",
									activity: agent.getLatestActivity?.(),
									transcript,
									unsupervisedMs,
								},
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					},
					supervisionIntervalMs: SUPERVISION_REMINDER_MS,
				}
			: {}),
		getWidget: () => widgetSurface(),
		hasParent: HAS_PARENT,
	});
	const controlBridges = new Set<ExternalControlBridge>();
	if (!HAS_PARENT) {
		pi.on("agent_start", () => registry.parentBecameActive());
		pi.on("agent_end", () => registry.parentBecameIdle());
	}

	// Inbound messages (a child addresses @parent, forwards a sibling's
	// message, or reports an unroutable target) land here from its rpc event
	// stream and re-enter the router on this hop.
	const onChildMessage = (msg: AgentMessage): void => {
		void handleMessage(pi, registry, msg, false);
	};

	// Tree telemetry for this node's own children (up-report) and forwarding
	// of deeper events. Lives at extension scope: the tracked-set must span
	// executes (a background child reports activity long after its execute returned).
	const tree = createTreeTelemetry(HAS_PARENT);
	const startupProfiles = discoverAgentProfiles(process.cwd());
	const spawnableProfiles = HAS_PARENT
		? ALLOWED_SUBAGENTS.map((name) => startupProfiles.profiles.get(name)).filter((p) => p !== undefined)
		: [...startupProfiles.profiles.values()];
	const spawnableSummary = spawnableProfiles.length
		? spawnableProfiles
				.map((profile) => (profile.description ? `${profile.name} — ${profile.description}` : profile.name))
				.join("; ")
		: "none";

	if (canDelegate(HAS_PARENT, ALLOWED_SUBAGENTS)) {
		// ── agent_spawn ────────────────────────────────────
		pi.registerTool({
			name: "agent_spawn",
			label: "Agent Spawn",
			description:
				`Spawn one configured agent profile. Available from this level: ${spawnableSummary}. ` +
				"Profile/settings choose model and thinking; the spawn call cannot impose budgets, tool restrictions, or a timeout.",
			promptSnippet: `Delegate to a configured agent (${spawnableSummary})`,
			promptGuidelines: [
				"Choose an exact configured agent name. Unknown agents fail; there is no fallback role.",
				"The profile already contains stable role instructions. Put only the concrete task, relevant paths/evidence, constraints, and desired result in prompt.",
				"Nested delegation is explicit: a sub-agent can spawn only names listed in its allowed_subagents profile field.",
				"If a child returns a question, answer that same resident child with agent_send instead of starting a replacement.",
				"The root chooses foreground/background per spawn. Several independent root spawns may run concurrently; background execution is root-only.",
			],
			parameters: SpawnParamsSchema,

			async execute(_toolCallId, raw, signal, onUpdate, ctx) {
				captureUi(ctx);
				const params = raw as unknown as SpawnParams;
				const requestedAgent = params.agent?.trim();
				if (!requestedAgent) {
					return toErrorResult("`agent` is required.");
				}
				const catalog = discoverAgentProfiles(ctx.cwd);
				const profile = catalog.profiles.get(requestedAgent);
				if (!profile) {
					return toErrorResult(
						`Unknown agent profile ${JSON.stringify(requestedAgent)}. Available: ${formatAvailableProfiles(catalog)}`,
					);
				}
				if (HAS_PARENT && !ALLOWED_SUBAGENTS.includes(profile.name)) {
					const allowed = ALLOWED_SUBAGENTS.length ? ALLOWED_SUBAGENTS.join(", ") : "none";
					return toErrorResult(
						`Agent ${JSON.stringify(CURRENT_AGENT_PROFILE || MY_AGENT_ID)} cannot spawn ${JSON.stringify(profile.name)}. Allowed subagents: ${allowed}.`,
					);
				}
				const runtimeProfile = resolveAgentProfile(profile, ctx.cwd);
				// Label is cosmetic; profile identity controls behavior/delegation.
				const label = params.label?.trim() || profile.name;
				// Schema hides run_in_background from sub-agents; this guard catches
				// hallucinated args (schema validation may pass extras through).
				if (HAS_PARENT && params.run_in_background != null) {
					return {
						content: [
							{
								type: "text",
								text:
									"run_in_background is root-only: your lifetime ends when this call returns, so " +
									"background work could not outlive you nor deliver its result. For parallel " +
									"work, issue several foreground agent_spawn calls together (they run " +
									"concurrently); for long-running work, describe it in your reply so the " +
									"caller can decide.",
							},
						],
						details: { error: "background spawns are root-only", label },
						isError: true,
					};
				}
				const runInBackground = HAS_PARENT ? false : params.run_in_background === true;
				const task = params.prompt?.trim();
				if (!task) {
					return {
						content: [{ type: "text", text: "`prompt` is required." }],
						details: { error: "`prompt` is required." },
						isError: true,
					};
				}

				const resolved = resolveModel(ctx.modelRegistry, ctx.model, runtimeProfile.resolvedModel);
				if (resolved.error) {
					// Background: render as the status line `Agent <label> start failed:
					// <reason>` (the id never exists yet — spawn didn't happen).
					return {
						content: [{ type: "text", text: resolved.error }],
						details: runInBackground
							? { runInBackground: true, label, error: resolved.error }
							: { error: resolved.error },
						isError: true,
					};
				}

				const startedAt = Date.now();

				// Foreground: stream the sub-agent's session as an ordered activity
				// stream. AgentProcess accumulates RenderEvents internally at the
				// source (RPC event handler); the callbacks here only refresh the
				// live card via onUpdate.
				let streamed = "";
				// Where my child's subtree telemetry lands (SPEC: 显示面统一规则) —
				// fold into THIS card while it's open, forward to my parent, or
				// surface on the root widget. One module owns the whole decision.
				const subtree = createSubtreeDisplay({
					hasParent: HAS_PARENT,
					foregroundEdge: !runInBackground,
					getWidget: () => {
						ensureWidget(ctx);
						return widget ?? undefined;
					},
					forward: (event) => tree.report(event),
					onFold: () =>
						onUpdate?.({
							content: [{ type: "text", text: streamed }],
							details: liveDetails(agent.getLatestActivity()),
						}),
				});
				// Live-card details: the shared slice every foreground update carries.
				const liveDetails = (activity?: AgentActivity): SubagentDetails => ({
					task,
					runtime: "profiled-subagents",
					profile: profile.name,
					treeId: AGENT_TREE_ID,
					parentAgentId: MY_AGENT_ID || "root",
					agentId,
					controlDir: control?.controlDir,
					statusPath: control?.statusPath,
					state: agent?.awaitingParent ? "waiting" : agent?.status,
					startedAt,
					model: agent.model,
					thinking: agent.thinking,
					activity,
					events: agent.getEvents(),
					nested: subtree.nested(),
				});
				// Short human-name id (max, zoe…) — the LLM-facing reference. No tree
				// structure: agents address only ids they were given, hop by hop.
				const agentId = registry.nextAgentId();
				let pendingQuestion: AgentQuestion | undefined;
				const notifyQuestion = (question: AgentQuestion): void => {
					pi.sendMessage(
						{
							customType: "subagent-question",
							content: JSON.stringify({
								agent_id: `@${agentId}`,
								profile: profile.name,
								question: question.question,
								context: question.context ?? null,
							}),
							display: true,
							details: { agentId, profile: profile.name, label, ...question },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				};
				const wakeCompletion = async (status: "completed" | "failed") => {
					const [output, stats] = await Promise.all([agent.lastOutput(), agent.getStats()]);
					return {
						status,
						output: output || (status === "failed" ? "Follow-up turn failed (model API error)." : output),
						stats: {
							tokens: stats?.tokens ?? 0,
							toolUses: stats?.toolUses ?? 0,
							durationMs: Date.now() - agent.startedAt,
						},
						sessionPath: agent.sessionPath,
						sessionId: agent.sessionId,
					} as const;
				};
				const settleWake = async (status: "completed" | "failed"): Promise<void> => {
					const completion = await wakeCompletion(status);
					const waited = registry.recordSettlement(agentId, { completion });
					if (!waited && !agent.stoppedByControl) notifyCompletion(pi, agent, completion);
				};
				const live = createLiveChannels({
					// getWidget, not widget: the widget is created on first use, so a
					// captured reference would be null for every update before that.
					surfaces: { getWidget: () => widget ?? undefined, tree },
					...(runInBackground
						? {}
						: {
								card: {
									delta: (text: string) => {
										streamed += text;
										onUpdate?.({
											content: [{ type: "text", text: streamed }],
											details: liveDetails(agent.getLatestActivity()),
										});
									},
									activity: (activity: AgentActivity) => {
										onUpdate?.({ content: [{ type: "text", text: streamed }], details: liveDetails(activity) });
									},
								},
							}),
				});

				const agent = new AgentProcess({
					agentId,
					cwd: ctx.cwd,
					model: resolved.model,
					thinking: runtimeProfile.resolvedThinking ?? pi.getThinkingLevel(),
					appendSystemPrompt: runtimeProfile.prompt || undefined,
					label,
					sessionDir: SUBAGENT_SESSION_DIR,
					// Resident after completion (idle, zero token) — explicit opt-in.
					persistent: params.persistent,
					// Identity for in-tree messaging: PI_SUBAGENT_AGENT_ID marks this
					// process as a child (agent_send is registered on every instance).
					env: {
						PI_SUBAGENT_AGENT_ID: agentId,
						PI_SUBAGENT_PROFILE: profile.name,
						PI_SUBAGENT_ALLOWED_SUBAGENTS: JSON.stringify(profile.allowedSubagents),
						PI_SUBAGENT_TREE_ID: AGENT_TREE_ID,
					},
					// Child→parent messages re-enter the router on this hop. Tree telemetry
					// from deeper spawns forwards up (depth + 1) or lands on the root widget.
					onMessage: onChildMessage,
					onQuestion: (question) => {
						pendingQuestion = question;
					},
					onTreeEvent: (event) => subtree.onTreeEvent(event),
					// A wake finished. Completed: its output must reach this spawner's
					// context — symmetric with the first-completion notification, an
					// agent_send "delivered" alone would leave the answer unread.
					// Deliberate stops stay silent (stoppedByControl). A failed
					// follow-up is reported (abnormal end) then cleaned up.
					onIdle: (outcome) => {
						if (outcome === "completed") {
							if (agent.awaitingParent && agent.pendingQuestion) {
								pendingQuestion = agent.pendingQuestion;
								void wakeCompletion("completed")
									.then((completion) => {
										const waited = registry.recordSettlement(agentId, {
											completion,
											waitingForParent: true,
											question: agent.pendingQuestion,
										});
										if (!waited && agent.pendingQuestion) notifyQuestion(agent.pendingQuestion);
										registry.markIdle(agentId);
									})
									.catch(() => {});
								return;
							}
							void settleWake("completed").catch(() => {});
							if (agent.persistent) {
								registry.markIdle(agentId);
							} else {
								tree.remove(agentId, "done");
								void registry.stopAndRemove(agentId).catch(() => {});
							}
							return;
						}
						void settleWake("failed")
							.then(() => tree.remove(agentId, "failed"))
							.then(() => registry.stopAndRemove(agentId))
							.catch(() => {});
					},
					// Where live output goes lives in live-output.ts: the widget row and
					// the tree fold hear about every update (a woken resident agent has a
					// row and no card), and the card below exists only for a foreground
					// spawn while its tool call runs.
					onDelta: (delta) => live.onDelta(agent, delta),
					onActivityChange: (activity) => live.onActivity(agent, activity),
				});
				const control = new ExternalControlBridge(
					agent,
					{
						profile: profile.name,
						parentPid: process.pid,
						treeId: AGENT_TREE_ID,
						parentAgentId: MY_AGENT_ID || "root",
					},
					{
						steer: async (message) => {
							const ok = registry.lookup(agentId)
								? await registry.deliver(agentId, message)
								: await agent.sendMessage(message);
							if (ok && !HAS_PARENT) registry.startSupervision(agentId);
							return ok;
						},
						stop: async () => {
							if (registry.lookup(agentId)) {
								const stopped = await registry.stopAndRemove(agentId);
								if (stopped) tree.remove(agentId, "stopped");
							} else {
								await agent.stop();
							}
						},
					},
				);
				controlBridges.add(control);
				control.start();

				// Lifecycle lives in spawn-session.ts — this switch only formats
				// outcomes into tool results; classification rules are table-tested
				// in test/spawn-session.test.ts.
				let outcome: SpawnOutcome;
				try {
					outcome = await runSpawnSession(agent, {
						task,
						runInBackground,
						signal,
						hooks: {
							onWorking: () =>
								onUpdate?.({
									content: [{ type: "text", text: "Working\u2026" }],
									details: liveDetails(),
								}),
							onBackgroundStarting: () =>
								onUpdate?.({
									content: [{ type: "text", text: `Starting ${agent.label}\u2026` }],
									details: { ...liveDetails(), runInBackground: true },
								}),
							// Background settled: wire widget + registry + the completion
							// chain here (mechanisms stay on this side of the seam).
							onBackgroundSettled: (a) => {
								ensureWidget(ctx); // widget row added via the registry (non-TUI: no-op)
								registry.register(a as AgentProcess);
								if (!HAS_PARENT) registry.startSupervision(a.agentId);
								tree.add(a, "running"); // up-report: my child exists
								void a
									.waitForCompletion()
									.then((completion) => {
										const child = a as AgentProcess;
										if (completion.status === "completed" && child.awaitingParent && child.pendingQuestion) {
											pendingQuestion = child.pendingQuestion;
											const waited = registry.recordSettlement(child.agentId, {
												completion,
												waitingForParent: true,
												question: child.pendingQuestion,
											});
											if (!waited) notifyQuestion(child.pendingQuestion);
											registry.markIdle(child.agentId);
											return;
										}
										tree.remove(
											a.agentId,
											completion.status === "completed"
												? "done"
												: completion.status === "failed"
													? "failed"
													: "stopped",
										);
										void registry.complete(child, completion);
									})
									// Defensive: waitForCompletion normally resolves from child lifecycle events;
									// if it ever rejects, clean up without notifying.
									.catch(() => {
										tree.remove(a.agentId, "stopped");
										registry.stopAndRemove(a.agentId);
									});
							},
							onResident: (a) => {
								ensureWidget(ctx);
								// Resident from birth: register the widget row as idle (‖
								// marker, stays addressable). Registering an already-completed
								// agent at its terminal status would be removed by the
								// widget's terminal cleanup before markIdle could flip it.
								registry.register(a as AgentProcess, "idle");
								tree.add(a, "idle");
							},
							// Foreground settled: report the child upward (widget-rooted
							// nodes only — at the root the card itself is the display; a
							// card-contained node's subtree folds at its own anchor). This
							// closes the blind spot where a background agent's foreground
							// children were invisible entirely.
							onForegroundSettled: (a) => {
								if (HAS_PARENT) tree.add(a, "running");
							},
						},
					});
				} catch (err) {
					return toErrorResult(err);
				}

				subtree.closeCard(); // from here on onUpdate cannot refresh the card
				switch (outcome.kind) {
					case "spawn-failed":
						// The isError return carries the failure to the LLM and the status
						// line shows it to the user — no follow-up notification on top.
						return spawnErrorResult(outcome, {
							runInBackground,
							label: agent.label,
						});

					case "background-started": {
						onUpdate?.({
							content: [{ type: "text", text: `Started ${agent.label} (background)` }],
							details: {
								runInBackground: true,
								runtime: "profiled-subagents",
								profile: profile.name,
								treeId: AGENT_TREE_ID,
								parentAgentId: MY_AGENT_ID || "root",
								agentId,
								controlDir: control.controlDir,
								statusPath: control.statusPath,
								state: agent.awaitingParent ? "waiting" : agent.status,
								label: agent.label,
								model: agent.model,
								thinking: agent.thinking,
								startedAt,
							} satisfies SubagentDetails,
						});
						return {
							content: [
								{
									type: "text",
									text: `Started background agent @${agent.agentId}. Completion arrives as a notification.`,
								},
							],
							details: {
								runInBackground: true,
								runtime: "profiled-subagents",
								profile: profile.name,
								treeId: AGENT_TREE_ID,
								parentAgentId: MY_AGENT_ID || "root",
								agentId,
								controlDir: control.controlDir,
								statusPath: control.statusPath,
								state: agent.awaitingParent ? "waiting" : agent.status,
								label: agent.label,
								model: agent.model,
								thinking: agent.thinking,
								startedAt,
							} satisfies SubagentDetails,
						};
					}

					case "finished": {
						if (outcome.status === "completed" && agent.awaitingParent) {
							const question = pendingQuestion ?? agent.pendingQuestion;
							if (question) {
								const contextLine = question.context ? `\nContext: ${question.context}` : "";
								return {
									content: [
										{
											type: "text",
											text: `Agent @${agentId} is waiting for your answer:\n${question.question}${contextLine}\n\nReply to the same agent with agent_send; its context is preserved.`,
										},
									],
									details: {
										runtime: "profiled-subagents",
										agentId,
										profile: profile.name,
										treeId: AGENT_TREE_ID,
										parentAgentId: MY_AGENT_ID || "root",
										label,
										controlDir: control.controlDir,
										statusPath: control.statusPath,
										state: "waiting",
										waitingForParent: true,
										question: question.question,
										context: question.context,
										sessionPath: outcome.sessionPath,
										sessionId: outcome.sessionId,
									},
								};
							}
						}
						// Failed or externally-stopped children are errors for the caller: the
						// stopped case must not look like a clean success. A user cancel
						// (abort) also produces a stopped outcome.
						if (outcome.status === "failed" || outcome.status === "stopped") {
							if (HAS_PARENT && !outcome.resident)
								tree.remove(agentId, outcome.status === "failed" ? "failed" : "stopped");
							const message =
								outcome.status === "failed"
									? outcome.output || "Sub-agent failed."
									: outcome.stoppedByControl
										? outcome.output || "Sub-agent stopped."
										: outcome.output || "Sub-agent stopped before completing; output may be partial.";
							return {
								content: [{ type: "text", text: truncateForContext(message) }],
								details: {
									runtime: "profiled-subagents",
									profile: profile.name,
									treeId: AGENT_TREE_ID,
									parentAgentId: MY_AGENT_ID || "root",
									agentId,
									controlDir: control.controlDir,
									statusPath: control.statusPath,
									state: agent.status,
									task,
									startedAt,
									endedAt: outcome.endedAt,
									// Full message (uncapped) — the user reads it on the card,
									// folded but never dropped; the LLM sees the capped copy.
									error: message,
									model: agent.model,
									thinking: agent.thinking,
									sessionPath: outcome.sessionPath,
									events: outcome.events,
									nested: subtree.nested(),
								} satisfies SubagentDetails,
								isError: true,
							};
						}
						if (HAS_PARENT && !outcome.resident) tree.remove(agentId, "done");
						return {
							// Pure text result — no session hint: the output stands alone
							// (the session path is the card footer, recoverable by the user).
							// A persistent foreground agent stays resident — the LLM needs
							// its id to wake it later with agent_send (or stop it).
							content: [
								{
									type: "text",
									text: outcome.resident
										? `${truncateForContext(outcome.output)}${maybeWriteFullOutput(agent.agentId, outcome.output)}\n\n(agent @${agent.agentId} is resident \u2014 send it follow-ups with agent_send)`
										: truncateForContext(outcome.output) + maybeWriteFullOutput(agent.agentId, outcome.output),
								},
							],
							details: {
								runtime: "profiled-subagents",
								profile: profile.name,
								treeId: AGENT_TREE_ID,
								parentAgentId: MY_AGENT_ID || "root",
								agentId,
								controlDir: control.controlDir,
								statusPath: control.statusPath,
								state: agent.awaitingParent ? "waiting" : agent.status,
								task,
								sessionPath: outcome.sessionPath,
								sessionId: outcome.sessionId,
								startedAt,
								endedAt: outcome.endedAt,
								model: agent.model,
								thinking: agent.thinking,
								events: outcome.events,
								nested: subtree.nested(),
							} satisfies SubagentDetails,
						};
					}
				}
			},

			...spawnView,
		});
	}

	// ── agent_wait ───────────────────────────────────────
	pi.registerTool({
		name: "agent_wait",
		label: "Wait for Agent",
		description:
			"Wait for a direct child to settle, fail/stop, or ask its parent a question. timeout_seconds limits only this wait call: expiry returns a live transcript snapshot and never stops the child. Omit it for the default 180-second supervision window.",
		promptSnippet: "Wait for a background or resumed child to settle",
		promptGuidelines: [
			"Use agent_wait when a background child's result becomes the next dependency instead of polling shell/status output.",
			"For supervision, a 150-second wait window is a useful cadence. A wait timeout never stops the child; inspect the returned latest activity and wait again when progress is sensible.",
			"If timeout_seconds is omitted, agent_wait uses a 180-second supervision window. timeout_seconds: 0 returns an immediate live snapshot.",
			"If agent_wait returns an ask_parent question, answer that same child with agent_send; call agent_wait again only after the answer when you need the resumed result.",
		],
		parameters: WaitParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as WaitParams;
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
			onUpdate?.({
				content: [{ type: "text", text: `Waiting for ${atId(agentId)} (${waitLabel})…` }],
				details: { agentId, timeoutSeconds },
			});
			let settlement: AgentSettlement | null | undefined;
			try {
				settlement = await registry.waitForSettlement(agentId, signal, timeoutMs);
			} catch (error) {
				return toErrorResult(error);
			}
			if (settlement === null) {
				const live = registry.lookup(agentId);
				if (!live) return toErrorResult(`Agent ${atId(agentId)} stopped being waitable while the wait window expired.`);
				const activity = live.getLatestActivity?.();
				const elapsedMs = live.startedAt ? Date.now() - live.startedAt : undefined;
				const messages = live.getMessages ? await live.getMessages().catch(() => []) : [];
				const transcript = formatTranscript(messages, { maxMessages: 6, maxChars: 6_000, perMessageChars: 1_200 });
				const window = timeoutSeconds === 0 ? "Status snapshot" : `Wait window of ${timeoutSeconds}s expired`;
				return {
					content: [
						{
							type: "text",
							text:
								`${window}; ${atId(agentId)} is still ${live.status ?? "running"}. Latest activity: ${activitySummary(activity)}. ` +
								"The wait window did not stop the agent. If progress is sensible, wait again; otherwise steer with agent_send or stop it." +
								`\n\nRecent transcript:\n${transcript}`,
						},
					],
					details: {
						agentId,
						state: live.status ?? "running",
						timedOut: timeoutSeconds !== 0,
						timeoutSeconds,
						activity,
						transcript,
						elapsedMs,
					},
				};
			}
			if (!settlement) return toErrorResult(`Unknown or no-longer-waitable direct child ${atId(agentId)}.`);
			const completion = settlement.completion;
			if (settlement.waitingForParent && settlement.question) {
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
			"Read a direct child's current state and recent live Pi transcript without stopping, steering, or otherwise changing the child.",
		promptSnippet: "Inspect a running child's recent transcript",
		promptGuidelines: [
			"Use agent_inspect when supervision needs more evidence than the latest activity marker. It is read-only.",
			"Prefer the default recent tail; request more messages only when the recent context is insufficient.",
		],
		parameters: InspectParamsSchema,

		async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as InspectParams;
			const rawId = params.agent_id?.trim();
			const agentId = rawId?.replace(/^@/, "");
			if (!agentId) return toErrorResult("`agent_id` is required.");
			const agent = registry.lookup(agentId);
			if (!agent) return toErrorResult(`Unknown or no-longer-live direct child ${atId(agentId)}.`);
			const maxMessages = params.max_messages ?? 12;
			if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 30) {
				return toErrorResult("`max_messages` must be an integer from 1 to 30.");
			}
			const messages = agent.getMessages ? await agent.getMessages().catch(() => []) : [];
			const transcript = formatTranscript(messages, { maxMessages, maxChars: 20_000, perMessageChars: 2_000 });
			const activity = agent.getLatestActivity?.();
			const elapsedMs = agent.startedAt ? Date.now() - agent.startedAt : undefined;
			if (!HAS_PARENT) registry.touchSupervision(agentId);
			return {
				content: [
					{
						type: "text",
						text: `${atId(agentId)} — ${agent.status ?? "running"}; latest activity: ${activitySummary(activity)}\n\nRecent transcript:\n${transcript}`,
					},
				],
				details: {
					agentId,
					label: agent.label,
					state: agent.status ?? "running",
					activity,
					transcript,
					elapsedMs,
					sessionPath: agent.sessionPath,
				},
			};
		},
	});

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
			const params = raw as StopParams;
			// Honour the @ reference form we teach — strip once, use everywhere
			// (lookup, stopAndRemove, details) so no @@ double prefix appears.
			const agentId = params.agent_id.replace(/^@/, "");
			const agent = registry.lookup(agentId);

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
				const stopped = await registry.stopAndRemove(agentId);
				if (stopped) tree.remove(agentId, "stopped");
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
			"Send follow-up instructions to a persistent or waiting agent with agent_send — its context is intact and it wakes to handle the message.",
			"When a child is waiting after ask_parent, answer that exact child id with agent_send rather than spawning a replacement.",
		],
		parameters: SendParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as SendParams;
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

			onUpdate?.({
				content: [{ type: "text", text: `Sending to ${atId(target)}\u2026` }],
				details: { to: target },
			});
			const r = await handleMessage(pi, registry, { to: target, from: MY_AGENT_ID, message }, true);
			if (r.ok && !HAS_PARENT && target !== "@parent" && registry.lookup(target)) registry.startSupervision(target);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: r.error ?? "delivery failed" }],
					details: { to: target, error: r.error },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `${r.verb} to ${atId(target)}.` }],
				// Card title shows @id — target label (uniform with agent_stop).
				details: {
					to: target,
					message,
					label: registry.lookup(target)?.label,
					agentId: registry.lookup(target)?.agentId,
				},
			};
		},

		...sendView,
	});

	// ── ask_parent ──────────────────────────────────────
	if (HAS_PARENT) {
		pi.registerTool({
			name: "ask_parent",
			label: "Ask Parent",
			description:
				"Ask the immediate spawning agent for a material clarification that cannot safely be resolved from the task, repository, or available evidence. The current turn yields and this same context resumes when the parent answers.",
			promptSnippet: "Ask your spawning agent for a blocking clarification",
			promptGuidelines: [
				"Use ask_parent only for material ambiguity or missing information that would make guessing unsafe; make routine implementation decisions yourself.",
				"After ask_parent succeeds, stop work and end the turn. Do not continue on an assumption. The parent will answer this same resident context with agent_send.",
			],
			parameters: AskParentParamsSchema,

			async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
				captureUi(ctx);
				const params = raw as AskParentParams;
				const question = params.question?.trim();
				const context = params.context?.trim();
				if (!question) return toErrorResult("`question` is required.");
				const payload: AgentQuestion = {
					from: MY_AGENT_ID,
					question,
					...(context ? { context } : {}),
				};
				uiRef?.setStatus(QUESTION_STATUS_KEY, JSON.stringify(payload));
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

	// ── Notification card (user side) ───────────────────
	pi.registerMessageRenderer("subagent-notification", renderNotification);

	// ── Cleanup on exit ─────────────────────────────────
	pi.on("session_shutdown", async (event) => {
		// Quit: the whole process is ending. Reload: pi rebuilds the extension
		// runtime in the same process — emitSessionShutdownEvent(reason:"reload")
		// fires on the OLD runner before it is invalidated, so this handler still
		// owns the registry and can stop its sub-agents cleanly; otherwise a
		// /reload would leave resident rpc children whose stdin pipe stays open.
		if (event.reason !== "quit" && event.reason !== "reload") return;

		// Graceful stop of every tracked agent. Children exit on their own
		// (stdin EOF → rpc shutdown) even if the parent dies first, because
		// the pipe closes — no tmux, no disk cleanup, no signals.
		await registry.shutdown();
		for (const bridge of controlBridges) bridge.cleanup();
		controlBridges.clear();
	});
}
