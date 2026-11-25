import { registerDiscoveryTools } from "./discovery-tools.js";
import { registerParentDeliveryHooks, registerToolErrorHook } from "./parent-delivery.js";
import { registerSpawnTool } from "./spawn-tool.js";
import { activitySummary, createSupervisionReminder } from "./supervision-reminder.js";
import { createTreeTelemetry } from "./tree-telemetry.js";
/**
 * pi-subagent — spawn isolated sub‑agent pi instances + in-tree messaging.
 *
 * Architecture:
 *   index.ts          — entrypoint, shared registry and extension hooks
 *   spawn-tool.ts     — agent_spawn, child process and completion wiring
 *   spawn-identity.ts — exact child environment identity and ancestor chain
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
import { registerControlTools } from "./control-tools.js";
import { MessageRouter } from "./message-router.js";

export { buildSpawnParamsSchema, canDelegate, shouldRunInBackground } from "./tool-params.js";

import type { AgentProcess } from "./agent-process.js";

import type { ExternalControlBridge } from "./external-control.js";

import { registerMonitoringTools } from "./monitoring-tools.js";
import { notifyCompletion } from "./notification.js";
import { discoverAgentProfiles, parseAllowedSubagentsEnv } from "./profiles.js";
import type { AgentMessage } from "./protocol.js";
import { RecoveryStore } from "./recovery.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import { renderNotification } from "./render.js";
import { SpawnCoordinator } from "./spawn-coordinator.js";

import { IncrementalTranscriptCursor } from "./transcript.js";

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

// ─── Helpers ─────────────────────────────────────────────────

const SUPERVISION_REMINDER_MS = 180_000;

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

// ─── Default export (pi extension entry) ───────────────────────

export default function (pi: ExtensionAPI) {
	registerToolErrorHook(pi);

	// Separate compact-recent and full-history cursors. A compact view never consumes full evidence.
	const transcriptCursors = new Map<string, IncrementalTranscriptCursor>();
	const recentTranscriptCursors = new Map<string, IncrementalTranscriptCursor>();
	const unreadTranscript = (
		agent: Pick<RegisteredAgent, "agentId" | "sessionPath" | "getEntries">,
		options: { maxMessages: number; maxChars: number; perMessageChars: number; detail?: "recent" | "full" },
		newestFirst = false,
	) => {
		const cursors = options.detail === "recent" ? recentTranscriptCursors : transcriptCursors;
		let cursor = cursors.get(agent.agentId);
		if (!cursor) {
			cursor = new IncrementalTranscriptCursor();
			cursors.set(agent.agentId, cursor);
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
					remind: createSupervisionReminder(pi, (agentId) => registry.lookup(agentId)),
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
	registerParentDeliveryHooks(pi, registry, router);

	// Inbound messages (a child addresses @parent, forwards a sibling's
	// message, or reports an unroutable target) land here from its rpc event
	// stream and re-enter the router on this hop.
	const onChildMessage = (msg: AgentMessage): void => {
		void router.route(msg, false);
	};

	// Tree telemetry for this node's own children (up-report) and forwarding
	// of deeper events. Lives at extension scope: the tracked-set must span
	// executes (a background child reports activity long after its execute returned).
	const tree = createTreeTelemetry(HAS_PARENT, MY_AGENT_ID, (key, value) => uiRef?.setStatus(key, value));
	const startupProfiles = discoverAgentProfiles(process.cwd());
	const spawnableProfiles = HAS_PARENT
		? ALLOWED_SUBAGENTS.map((name) => startupProfiles.profiles.get(name)).filter((p) => p !== undefined)
		: [...startupProfiles.profiles.values()];
	const spawnableSummary = spawnableProfiles.length
		? spawnableProfiles
				.map((profile) => (profile.description ? `${profile.name} — ${profile.description}` : profile.name))
				.join("; ")
		: "none";

	registerDiscoveryTools(pi, { registry, recovery, toErrorResult });

	registerSpawnTool(pi, {
		hasParent: HAS_PARENT,
		allowedSubagents: ALLOWED_SUBAGENTS,
		parentAgentId: MY_AGENT_ID,
		treeId: AGENT_TREE_ID,
		sessionDir: SUBAGENT_SESSION_DIR,
		spawnableSummary,
		registry,
		spawnCoordinator,
		tree,
		captureUi,
		ensureWidget,
		getWidget: () => widget ?? undefined,
		onChildMessage,
		childRecoveryIds,
		controlBridges,
		recovery,
		toErrorResult,
	});

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
