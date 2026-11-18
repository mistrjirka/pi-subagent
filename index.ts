import { reportedAgentState } from "./agent-state.js";
/**
 * pi-subagent — spawn isolated sub‑agent pi instances + in-tree messaging.
 *
 * Architecture:
 *   index.ts          — entrypoint, shared registry, spawn lifecycle and extension hooks
 *   monitoring-tools.ts — agent_wait / agent_inspect
 *   control-tools.ts — agent_stop / agent_send / ask_parent
 *   message-router.ts — direct-child and parent message transport
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
 * (`customType: "subagent-notification"`, deliverAs "steer") carrying the
 * final output. agent_send messages flow along tree edges (parent↔child);
 * persistent agents stay resident (idle, zero token) and can be woken by a
 * message.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerControlTools } from "./control-tools.js";
import { MessageRouter } from "./message-router.js";
import { buildSpawnParamsSchema, canDelegate, type SpawnParams } from "./tool-params.js";

export { buildSpawnParamsSchema, canDelegate, shouldRunInBackground } from "./tool-params.js";

import { AgentProcess } from "./agent-process.js";
import { type AgentActivity, type AgentTreeEvent, TREE_STATUS_KEY } from "./event-interpret.js";
import { ExternalControlBridge } from "./external-control.js";
import { createLiveChannels } from "./live-output.js";
import { registerMonitoringTools } from "./monitoring-tools.js";
import { completionContextContent, notifyCompletion } from "./notification.js";
import { discoverAgentProfiles, parseAllowedSubagentsEnv } from "./profiles.js";
import { type AgentMessage, type AgentQuestion, formatParentMessage } from "./protocol.js";
import { RecoveryStore } from "./recovery.js";
import { AgentRegistry, buildAncestorChain, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import { renderNotification } from "./render.js";
import { SpawnCoordinator } from "./spawn-coordinator.js";
import { presentBackgroundSpawn, presentFinishedSpawn, type SpawnPresentationContext } from "./spawn-result.js";
import { runSpawnSession, type SpawnOutcome } from "./spawn-session.js";
import { getMonitoringTranscript, IncrementalTranscriptCursor } from "./transcript.js";
import { createSubtreeDisplay } from "./tree-display.js";
import type { SubagentDetails } from "./types.js";
import { spawnView } from "./views.js";
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

function ensureWidget(ctx: { mode: string; ui: ExtensionUIContext }): AgentWidget | null {
	captureUi(ctx);
	if (widget) return widget;
	if (ctx.mode !== "tui") return null;
	widget = new AgentWidget(ctx.ui);
	return widget;
}

/**
 * Refresh the child→parent handle from any tool execute. Every execute runs
 * with a UI context (rpc children too — their setStatus emits the
 * extension_ui_request event stream the parent consumes), and a sub-agent
 * must have run its own execute before it can spawn children, so the ref
 * is always warm before any inbound @parent message needs to go up.
 */
function captureUi(ctx: { mode: string; ui: ExtensionUIContext }): void {
	uiRef = ctx.ui;
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

const SpawnParamsSchema = buildSpawnParamsSchema(HAS_PARENT);

// ─── Helpers ─────────────────────────────────────────────────

const SUPERVISION_REMINDER_MS = 180_000;

function activitySummary(activity: AgentActivity | undefined): string {
	if (!activity) return "no recent activity reported";
	if (activity.kind === "thinking") return "thinking";
	if (activity.kind === "tool") {
		const args = activity.args.replace(/\s+/g, " ").trim();
		const excerpt = Array.from(args).slice(0, 180).join("");
		return `${activity.name}${excerpt ? ` — ${excerpt}${Array.from(args).length > 180 ? "…" : ""}` : ""}`;
	}
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
			event.toolName !== "agent_recover" &&
			event.toolName !== "agent_spawn" &&
			event.toolName !== "agent_wait" &&
			event.toolName !== "agent_inspect" &&
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

	// One shared transcript reader per direct child. Wait prioritizes new progress;
	// inspect backfills older unread history. Delivered entries are not repeated.
	const transcriptCursors = new Map<string, IncrementalTranscriptCursor>();
	const unreadTranscript = (
		agent: RegisteredAgent,
		options: { maxMessages: number; maxChars: number; perMessageChars: number },
		newestFirst = false,
	) => {
		let cursor = transcriptCursors.get(agent.agentId);
		if (!cursor) {
			cursor = new IncrementalTranscriptCursor();
			transcriptCursors.set(agent.agentId, cursor);
		}
		return newestFirst ? cursor.readRecent(agent, options) : cursor.read(agent, options);
	};

	// One registry per session: owns the running-agent bookkeeping, the
	// completion policy (notify unless user-stopped; cleanup on every path),
	// and the in-tree routing (direct children only — per-hop O(1)).
	const registry = new AgentRegistry({
		notify: (agent, completion, delivery) => notifyCompletion(pi, agent, completion, delivery),
		...(!HAS_PARENT
			? {
					remind: async (agent: Parameters<typeof notifyCompletion>[1], unsupervisedMs: number) => {
						const minutes = Math.max(1, Math.round(unsupervisedMs / 60_000));
						const activity = activitySummary(agent.getLatestActivity?.());
						const transcript = await getMonitoringTranscript(agent, {
							maxMessages: 4,
							maxChars: 4_000,
							perMessageChars: 1_000,
						});
						// Transcript collection is asynchronous. The child may settle while
						// it is in flight; do not emit a stale "still running" reminder.
						const current = registry.lookup(agent.agentId);
						if (current !== agent || (current.status && current.status !== "running" && current.status !== "queued")) {
							return;
						}
						pi.sendMessage(
							{
								customType: "subagent-supervision",
								content:
									`Subagent @${agent.agentId} has been running unsupervised for about ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
									`Latest activity: ${activity}. ` +
									"SUPERVISION CHECK REQUIRED: compare new evidence with the assigned scope and last correction. Is the child making real progress? " +
									"If progress remains aligned, continue with agent_wait (normally a 150-second window) without reassurance messages, document updates, or repeated audits. " +
									"Inspect or steer with agent_send for a concrete blocker, scope drift, repeated failure, or necessary coordination. Stop the child when needed. " +
									"A timeout or long-running command alone is not a stall. Use agent_wait for subagents rather than shell polling. Ordinary external processes may use process/job waits." +
									`\n\nRecent transcript (${transcript.source}):\n${transcript.text}`,
								display: true,
								details: {
									agentId: agent.agentId,
									label: agent.label,
									state: reportedAgentState(agent),
									activity: agent.getLatestActivity?.(),
									transcript: transcript.text,
									transcriptSource: transcript.source,
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
	const router = new MessageRouter(pi, registry, () => uiRef);
	const controlBridges = new Set<ExternalControlBridge>();
	// Root-owned persistent children can be explicitly recovered after their parent
	// exits. Nested workers retain only the existing in-process lifetime.
	const recovery = HAS_PARENT
		? undefined
		: new RecoveryStore(
				expandTilde(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")),
				SUBAGENT_SESSION_DIR,
			);
	// Both extensions share the current Pi event bus. Only a small, synchronous
	// snapshot is sent. Child transcripts and tool results remain private.
	pi.events.on("pi-subagent:checkpoint-roster:v1", (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const respond = (value as { respond?: unknown }).respond;
		if (typeof respond === "function") respond(registry.checkpointRoster());
	});
	const childRecoveryIds = new Map<string, string>();
	const spawnCoordinator = new SpawnCoordinator({
		hasParent: HAS_PARENT,
		allowedSubagents: ALLOWED_SUBAGENTS,
		currentAgentProfile: CURRENT_AGENT_PROFILE,
		parentAgentId: MY_AGENT_ID,
		...(recovery ? { recovery } : {}),
	});
	// Every Pi session can own a resident child, even though only the root may
	// spawn background work. Track the parent's actual active/settled window at
	// every depth so resumed-child announcements cannot race a late agent_wait.
	pi.on("agent_start", () => registry.parentBecameActive());
	// If progress arrives after the last tool result, steer it at the next
	// model-turn boundary rather than holding it until the parent fully settles.
	// Completions remain deferred, because agent_wait may still consume them.
	pi.on("turn_end", () => {
		for (const message of registry.takePendingParentMessages()) {
			router.deliverParentMessage(message);
			registry.noteDeliveredParentMessage(message);
		}
	});
	// Do not announce at turn_end: Pi queues the steer immediately, but a later
	// agent_wait can consume the same result before that steer reaches the model.
	// A tool result reports earlier completions; idle is the fallback boundary.
	pi.on("agent_settled", () => {
		const messages = registry.takePendingParentMessages();
		// Pi can settle without emitting another turn_end. Publish and account
		// for pending child progress *before* checking whether the completion
		// needs a new parent turn. Otherwise idle sends the completion first
		// and starts a redundant model request before the progress is counted.
		for (const message of messages) {
			router.deliverParentMessage(message);
			registry.noteDeliveredParentMessage(message);
		}
		registry.parentBecameIdle();
	});

	// A tool result is the next safe model-visible boundary during an active turn.
	// Consume once, while preserving the original tool output and error flag.
	pi.on("tool_result", (event) => {
		const { messages, completions } = registry.takePendingForToolResult();
		if (!messages.length && !completions.length) return undefined;
		const text = [
			"[Subagent updates received during this turn]",
			...messages.map((message) => `Message: ${formatParentMessage(message)}`),
			...completions.map(({ agent, completion }) => `Completion: ${completionContextContent(agent, completion)}`),
		].join("\n");
		return {
			content: [...event.content, { type: "text", text }],
			details: event.details,
			isError: event.isError,
			usage: event.usage,
		};
	});

	// Inbound messages (a child addresses @parent, forwards a sibling's
	// message, or reports an unroutable target) land here from its rpc event
	// stream and re-enter the router on this hop.
	const onChildMessage = (msg: AgentMessage): void => {
		void router.route(msg, false);
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

	// Context compaction replaces the parent's textual history, not the live
	// in-process children. Expose their current names without reading transcripts
	// so a compacted parent can rediscover them instead of spawning duplicates.
	pi.registerTool({
		name: "agent_list",
		label: "List Direct Agents",
		description:
			"Read-only list of running, waiting, resident/idle and recently finished direct child agents in this Pi process. Use after compaction or when an agent id is uncertain. After a Pi restart use agent_recover for saved persistent sessions instead.",
		promptSnippet: "Rediscover current direct child agents and their states after context compaction",
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
		async execute(_callId, raw) {
			const requested = (raw as { limit?: number }).limit;
			const limit =
				typeof requested === "number" && Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 20;
			return {
				content: [{ type: "text", text: registry.describeMessageTargets("", limit) }],
				details: { limit },
			};
		},
	});

	if (recovery) {
		pi.registerTool({
			name: "agent_recover",
			label: "Recover Agent Context",
			description:
				"List previous persistent subagent transcripts that can be resumed in the current project and Git branch. Read-only; never starts a child. To continue one, pass its recovery id to agent_spawn.resume_id with a fresh scoped prompt.",
			promptSnippet: "Find recoverable persistent child contexts after a Pi restart",
			promptGuidelines: [
				"Check recoverable agents when resuming substantial implementation after a Pi restart, before assigning fresh exploration.",
				"Reuse only when the role, project, Git branch, and task acceptance boundary still match. An old transcript is context, not proof that its changes still exist.",
				"Do not resume a worker already active in another Pi process. Supply the fresh goal, changed requirements and current code state as the new spawn prompt.",
			],
			parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
			async execute(_callId, raw, _signal, _onUpdate, ctx) {
				try {
					const matches = recovery.list(ctx.cwd, (raw as { limit?: number }).limit ?? 20);
					const text = matches.length
						? matches
								.map(
									({ record, available }) =>
										`${record.id} — ${record.profile} (${record.label}), ${available ? "recoverable" : "active elsewhere"}, ${record.updatedAt}, model ${record.model}`,
								)
								.join("\n")
						: "No recorded persistent agent contexts for this project and Git branch.";
					return {
						content: [
							{
								type: "text",
								text:
									text +
									"\nTo resume: agent_spawn({agent: <role>, resume_id: <id>, persistent: true, prompt: <fresh instructions>}).",
							},
						],
						details: { count: matches.length },
					};
				} catch (error) {
					return toErrorResult(error);
				}
			},
		});
	}

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
				"For substantial resumptions after a restart, use agent_recover first. A matching recovery id loads the saved child context; this prompt remains a fresh instruction. Never guess a recovery id or resume across project/branch/task boundaries.",
				"The root chooses foreground/background per spawn. Several independent root spawns may run concurrently; background execution is root-only.",
			],
			parameters: SpawnParamsSchema,

			async execute(_toolCallId, raw, signal, onUpdate, ctx) {
				captureUi(ctx);
				const params = raw as SpawnParams;
				const decision = spawnCoordinator.prepare(params, {
					cwd: ctx.cwd,
					modelRegistry: ctx.modelRegistry,
					model: ctx.model,
				});
				if (decision.kind === "rejected")
					return {
						content: [{ type: "text", text: decision.message }],
						details: {
							...(decision.runInBackground ? { runInBackground: true, label: decision.label } : {}),
							...(decision.error === "background spawns are root-only" ? { label: decision.label } : {}),
							error: decision.error,
						},
						isError: true,
					};
				const { profile, runtimeProfile, label, task, runInBackground, resolved } = decision;
				let recoveryId = decision.recoveryId;
				const resumeSessionPath = decision.resumeSessionPath;

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
						{ deliverAs: "steer", triggerTurn: true },
					);
				};
				const wakeCompletion = (status: "completed" | "failed", generation: number) =>
					agent.completionForTurn(status, generation);

				const live = createLiveChannels({
					// getWidget, not widget: the widget is created on first use, so a
					// captured reference would be null for every update before that.
					surfaces: { getWidget: () => widget ?? undefined, tree },
					// Live tail for external readers (PiTTy): attached for BOTH spawn
					// modes — unlike `card` below, which exists only for foreground.
					// `control` is assigned below before any event can flow.
					stream: (event) => control.appendEvents(event),
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
					taskSummary: task,
					sessionDir: SUBAGENT_SESSION_DIR,
					resumeSessionPath,
					// Resident after completion (idle, zero token) — explicit opt-in.
					persistent: params.persistent === true || Boolean(params.resume_id),
					...(recovery && (params.persistent || params.resume_id)
						? {
								onSessionReady: (sessionPath: string) => {
									if (recoveryId) {
										if (path.resolve(sessionPath) !== path.resolve(resumeSessionPath ?? "")) {
											throw new Error("Resumed Pi session did not return the expected transcript path");
										}
									} else {
										const record = recovery.create({
											cwd: ctx.cwd,
											profile: profile.name,
											label,
											model: resolved.model ?? "inherited",
											thinking: runtimeProfile.resolvedThinking ?? pi.getThinkingLevel(),
											sessionPath,
										});
										recoveryId = record.id;
									}
									childRecoveryIds.set(agentId, recoveryId);
								},
							}
						: {}),
					// Identity for in-tree messaging: PI_SUBAGENT_AGENT_ID marks this
					// process as a child (agent_send is registered on every instance).
					env: {
						PI_SUBAGENT_AGENT_ID: agentId,
						PI_SUBAGENT_PROFILE: profile.name,
						PI_SUBAGENT_ALLOWED_SUBAGENTS: JSON.stringify(profile.allowedSubagents),
						PI_SUBAGENT_TREE_ID: AGENT_TREE_ID,
						// Ancestor id chain so the child's registry never re-rolls
						// an ancestor/cousin name (whole-tree bare-id uniqueness).
						PI_SUBAGENT_ANCESTOR_IDS: buildAncestorChain(agentId, MY_AGENT_ID, process.env.PI_SUBAGENT_ANCESTOR_IDS),
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
					onIdle: (outcome, generation) => {
						if (outcome === "completed") {
							if (agent.awaitingParent && agent.pendingQuestion) {
								const question = agent.pendingQuestion;
								pendingQuestion = question;
								void wakeCompletion("completed", generation)
									.then((completion) => {
										if (!registry.acceptsCompletion(agent, completion)) return;
										registry.recordSettlement(
											agentId,
											{
												completion,
												waitingForParent: true,
												question,
											},
											question ? () => notifyQuestion(question) : undefined,
										);
										registry.markIdle(agentId);
									})
									.catch((error) => {
										pi.sendMessage(
											{
												customType: "subagent-error",
												content: `Subagent @${agentId} completion failed: ${String(error)}`,
												display: true,
											},
											{ deliverAs: "followUp", triggerTurn: true },
										);
									});
								return;
							}
							// A resumed ask_parent turn is a normal completion, not an
							// explicit stop. Finish collecting its output and record the
							// settlement before normal cleanup. Calling stopAndRemove here
							// races wakeCompletion(): markStopped() can otherwise overwrite
							// the just-produced final answer with a synthetic "stopped"
							// settlement before agent_wait receives it.
							void wakeCompletion("completed", generation)
								.then(async (completion) => {
									const accepted = await registry.complete(agent, completion);
									if (accepted && !agent.persistent) tree.remove(agentId, "done");
								})
								.catch((error) => {
									pi.sendMessage(
										{
											customType: "subagent-error",
											content: `Subagent @${agentId} completion failed: ${String(error)}`,
											display: true,
										},
										{ deliverAs: "followUp", triggerTurn: true },
									);
								});
							return;
						}
						void wakeCompletion("failed", generation)
							.then(async (completion) => {
								if (!(await registry.complete(agent, completion))) return;
								const recordId = childRecoveryIds.get(agentId);
								if (recordId) recovery?.suspend(recordId);
								tree.remove(agentId, "failed");
							})
							.catch((error) => {
								pi.sendMessage(
									{
										customType: "subagent-error",
										content: `Subagent @${agentId} completion failed: ${String(error)}`,
										display: true,
									},
									{ deliverAs: "followUp", triggerTurn: true },
								);
							});
					},
					// Where live output goes lives in live-output.ts: the widget row and
					// the tree fold hear about every update (a woken resident agent has a
					// row and no card), and the card below exists only for a foreground
					// spawn while its tool call runs. The events.jsonl tail additionally
					// hears about every mapped record in BOTH modes via onStream.
					onDelta: (delta) => live.onDelta(agent, delta),
					onActivityChange: (activity) => live.onActivity(agent, activity),
					onStream: (event) => live.onStream(agent, event),
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
								if (stopped) {
									tree.remove(agentId, "stopped");
									const recordId = childRecoveryIds.get(agentId);
									if (recordId) recovery?.retire(recordId);
								}
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
										if (!registry.acceptsCompletion(child, completion)) return;
										if (completion.status === "completed" && child.awaitingParent && child.pendingQuestion) {
											const question = child.pendingQuestion;
											pendingQuestion = question;
											registry.recordSettlement(
												child.agentId,
												{
													completion,
													waitingForParent: true,
													question,
												},
												() => notifyQuestion(question),
											);
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
										if (completion.status !== "completed") {
											const recordId = childRecoveryIds.get(child.agentId);
											if (recordId) recovery?.suspend(recordId);
										}
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
					if (recoveryId) recovery?.suspend(recoveryId);
					return toErrorResult(err);
				}

				subtree.closeCard(); // from here on onUpdate cannot refresh the card
				const presentation = (): SpawnPresentationContext => {
					const question = pendingQuestion ?? agent.pendingQuestion;
					return {
						agent,
						profile: profile.name,
						task,
						treeId: AGENT_TREE_ID,
						parentAgentId: MY_AGENT_ID || "root",
						controlDir: control.controlDir,
						statusPath: control.statusPath,
						startedAt,
						nested: subtree.nested(),
						...(resumeSessionPath ? { resumeSessionPath } : {}),
						...(recoveryId ? { recoveryId } : {}),
						...(question ? { pendingQuestion: question } : {}),
					};
				};
				switch (outcome.kind) {
					case "spawn-failed":
						if (recoveryId) {
							recovery?.suspend(recoveryId);
							childRecoveryIds.delete(agentId);
						}
						return spawnErrorResult(outcome, { runInBackground, label: agent.label });
					case "background-started": {
						const shown = presentBackgroundSpawn(presentation());
						if (shown.progress) onUpdate?.(shown.progress);
						return shown.result;
					}
					case "finished": {
						if (recoveryId && !outcome.resident) {
							if (outcome.stoppedByControl) recovery?.retire(recoveryId);
							else recovery?.suspend(recoveryId);
							childRecoveryIds.delete(agentId);
						}
						const shown = presentFinishedSpawn(outcome, presentation(), HAS_PARENT);
						if (shown.treeRemoval) tree.remove(agentId, shown.treeRemoval);
						return shown.result;
					}
				}
			},

			...spawnView,
		});
	}

	registerMonitoringTools(pi, {
		registry,
		captureUi,
		unreadTranscript,
		activitySummary,
		toErrorResult,
		hasParent: HAS_PARENT,
	});

	registerControlTools(pi, {
		registry,
		agentId: MY_AGENT_ID,
		hasParent: HAS_PARENT,
		captureUi,
		setStatus: (key, value) => uiRef?.setStatus(key, value),
		routeMessage: (message, outbound, answerToQuestion) => router.route(message, outbound, answerToQuestion),
		removeFromTree: (agentId) => tree.remove(agentId, "stopped"),
		retireRecovery: (agentId) => {
			const recordId = childRecoveryIds.get(agentId);
			if (recordId) recovery?.retire(recordId);
		},
		toErrorResult,
	});

	// ── Notification card (user side) ───────────────────
	pi.registerMessageRenderer("subagent-notification", renderNotification);

	// ── Cleanup on exit ─────────────────────────────────
	pi.on("session_shutdown", async () => {
		// Quit: the whole process is ending. Reload: pi rebuilds the extension
		// runtime in the same process — emitSessionShutdownEvent(reason:"reload")
		// fires on the OLD runner before it is invalidated, so this handler still
		// owns the registry and can stop its sub-agents cleanly; otherwise a
		// /reload would leave resident rpc children whose stdin pipe stays open.

		// Graceful stop of every tracked agent. Children exit on their own
		// (stdin EOF → rpc shutdown) even if the parent dies first, because
		// the pipe closes — no tmux, no disk cleanup, no signals.
		try {
			await registry.shutdown();
		} finally {
			recovery?.suspendAll();
			for (const bridge of controlBridges) bridge.cleanup();
			controlBridges.clear();
		}
	});
}
