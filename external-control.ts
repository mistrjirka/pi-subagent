import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "./event-interpret.js";

export type ExternalAgentState = "queued" | "running" | "waiting" | "idle" | "completed" | "failed" | "stopped";

export interface ExternallyControllableAgent {
	readonly agentId: string;
	readonly label: string;
	readonly startedAt: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly persistent?: boolean;
	readonly status: "queued" | "running" | "completed" | "failed" | "stopped";
	readonly awaitingParent?: boolean;
	readonly sessionPath?: string;
	sendMessage(text: string): Promise<boolean>;
	stop(): Promise<void>;
}

export interface ExternalControlMetadata {
	profile: string;
	parentPid: number;
	treeId: string;
	parentAgentId: string;
}

export interface ExternalControlActions {
	steer?: (message: string) => Promise<boolean>;
	stop?: () => Promise<void>;
}

export interface ExternalControlStatus {
	version: 1;
	runtime: "profiled-subagents";
	agentId: string;
	profile: string;
	treeId: string;
	parentAgentId: string;
	label: string;
	state: ExternalAgentState;
	startedAt: number;
	updatedAt: number;
	sessionPath?: string;
	model?: string;
	thinking?: string;
	waitingForParent?: boolean;
}

type SteerRequest = {
	type: "steer";
	id: string;
	message: string;
	ts?: number;
	source?: string;
};

type StopRequest = {
	type: "stop";
	id?: string;
	ts?: number;
	source?: string;
};

function sanitize(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "agent";
}

function runtimeRoot(): string {
	const suffix =
		typeof process.getuid === "function" ? `uid-${process.getuid()}` : `user-${sanitize(os.userInfo().username)}`;
	return path.join(os.tmpdir(), `pi-profiled-subagents-${suffix}`);
}

function mkdirPrivate(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(directory, 0o700);
	} catch {
		// Best effort on filesystems/platforms that do not implement POSIX modes.
	}
}

function atomicJson(filePath: string, value: unknown): void {
	mkdirPrivate(path.dirname(filePath));
	const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function stateOf(agent: ExternallyControllableAgent): ExternalAgentState {
	if (agent.awaitingParent) return "waiting";
	if (agent.status === "completed" && agent.persistent) return "idle";
	return agent.status;
}

/** O_NOFOLLOW where the platform defines it (0 elsewhere — open still applies). */
function openNoFollow(): number {
	return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

/**
 * Map one interpreted event onto an `events.jsonl` record. Undefined = no new
 * stream content (settle/message/question/tree/failure and the start/end
 * markers that repeat cumulative content). Block identity derives from the
 * wire contentIndex so consecutive lines sharing (runId, blockId) accumulate
 * into one in-flight item on the reader side.
 */
function toStreamRecord(
	event: AgentEvent,
):
	| { kind: ChildStreamLine["kind"]; blockId?: string; text?: string; toolName?: string; toolCallId?: string }
	| undefined {
	switch (event.type) {
		case "thinking":
			if (event.text === undefined) return undefined;
			return { kind: "thinking", blockId: `think-${event.contentIndex ?? 0}`, text: event.text };
		case "text_delta":
			return { kind: "text", blockId: `text-${event.contentIndex ?? 0}`, text: event.delta };
		case "tool_start":
			return { kind: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId };
		case "tool_call":
			return {
				kind: "tool_end",
				toolName: event.activity.name,
				...(event.activity.id !== undefined ? { toolCallId: event.activity.id } : {}),
			};
		default:
			return undefined;
	}
}

/** Tuning knobs for the `events.jsonl` appender (all optional; defaults implement the frozen contract). */
export interface ExternalControlOptions {
	/** Stop writing thinking/text lines after this many file bytes (tool lines continue). Default 2 MiB. */
	eventsCapBytes?: number;
	/** Coalescing window: a non-empty buffer is flushed at most this often. Default 250 ms. */
	flushIntervalMs?: number;
	/** Flush as soon as the buffered bytes exceed this. Default ~4 KiB. */
	maxBufferedBytes?: number;
}

/** One `events.jsonl` line as written (v: 1 envelope; readers ignore unknown fields). */
export interface ChildStreamLine {
	v: 1;
	seq: number;
	ts: number;
	runId: string;
	kind: "thinking" | "text" | "tool_start" | "tool_end";
	blockId?: string;
	text?: string;
	toolName?: string;
	toolCallId?: string;
	argsPreview?: string;
}

const EVENTS_CAP_BYTES = 2 * 1024 * 1024;
const EVENTS_FLUSH_MS = 250;
const EVENTS_BUFFER_BYTES = 4 * 1024;

/**
 * Tiny file bridge for UIs such as PiTTy. It is not an orchestration layer:
 * it only mirrors state and accepts direct steer/stop commands for this exact
 * resident child. No budgets, deadlines, pause semantics, or scheduling.
 */
export class ExternalControlBridge {
	readonly controlDir: string;
	readonly statusPath: string;
	/** Append-only live child event stream (`<controlDir>/events.jsonl`). */
	readonly eventsPath: string;
	private readonly inbox: string;
	private readonly acks: string;
	private timer: NodeJS.Timeout | undefined;
	private processing = false;
	// ── events.jsonl appender state ──
	private seq = 0;
	private fileBytes = 0;
	private buf: Array<{ line: string; kind: ChildStreamLine["kind"]; bytes: number }> = [];
	private bufBytes = 0;
	private bufKey = "";
	private lastFlush = Date.now();
	private flushTimer: NodeJS.Timeout | undefined;
	private eventsWritable = true;
	private readonly eventsCap: number;
	private readonly flushInterval: number;
	private readonly maxBuffered: number;

	constructor(
		private readonly agent: ExternallyControllableAgent,
		private readonly metadata: ExternalControlMetadata,
		private readonly actions: ExternalControlActions = {},
		options: ExternalControlOptions = {},
	) {
		const root = runtimeRoot();
		mkdirPrivate(root);
		this.controlDir = fs.mkdtempSync(path.join(root, `${metadata.parentPid}-${sanitize(agent.agentId)}-`), {
			encoding: "utf8",
		});
		try {
			fs.chmodSync(this.controlDir, 0o700);
		} catch {}
		this.statusPath = path.join(this.controlDir, "status.json");
		this.eventsPath = path.join(this.controlDir, "events.jsonl");
		this.inbox = path.join(this.controlDir, "control", "steer-requests");
		this.acks = path.join(this.controlDir, "control", "acks");
		mkdirPrivate(this.inbox);
		mkdirPrivate(this.acks);
		this.eventsCap = options.eventsCapBytes ?? EVENTS_CAP_BYTES;
		this.flushInterval = options.flushIntervalMs ?? EVENTS_FLUSH_MS;
		this.maxBuffered = options.maxBufferedBytes ?? EVENTS_BUFFER_BYTES;
		this.createEventsFile();
		this.writeStatus();
	}

	/**
	 * Append one mapped stream record to `events.jsonl` (coalesced; see writer
	 * rules in the file header contract). Never throws; a failed boundary
	 * write disables further event writes without affecting the agent run.
	 */
	appendEvents(event: AgentEvent): void {
		if (!this.eventsWritable) return;
		const record = toStreamRecord(event);
		if (!record) return;
		// 2 MB cap: drop thinking/text, keep tool_start/tool_end.
		if ((record.kind === "thinking" || record.kind === "text") && this.fileBytes >= this.eventsCap) return;
		const key = `${record.kind}\0${record.blockId ?? ""}`;
		// Flush when the kind (or blockId) changes so a reader never sees a
		// stale open block interleaved with a new one.
		if (this.buf.length > 0 && key !== this.bufKey) this.flushEvents();
		this.seq += 1;
		const line: ChildStreamLine = {
			v: 1,
			seq: this.seq,
			ts: Date.now(),
			runId: this.agent.agentId,
			kind: record.kind,
			...(record.blockId !== undefined ? { blockId: record.blockId } : {}),
			...(record.text !== undefined ? { text: record.text } : {}),
			...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
			...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
		};
		const serialized = `${JSON.stringify(line)}\n`;
		const bytes = Buffer.byteLength(serialized, "utf8");
		this.buf.push({ line: serialized, kind: record.kind, bytes });
		this.bufBytes += bytes;
		this.bufKey = key;
		if (this.bufBytes >= this.maxBuffered) {
			this.flushEvents();
		} else if (Date.now() - this.lastFlush >= this.flushInterval) {
			this.flushEvents();
		} else {
			this.scheduleFlush();
		}
	}

	/** Write the buffered lines (one O_APPEND open per flush, never per token, never fsync). */
	flushEvents(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.buf.length === 0 || !this.eventsWritable) {
			if (!this.eventsWritable) {
				this.buf = [];
				this.bufBytes = 0;
				this.bufKey = "";
			}
			return;
		}
		// Apply the 2 MB cap line-by-line at write time against the projected
		// total, so the file never grows past the cap; thinking/text past it are
		// dropped while tool lines in the same flush still land.
		let chunk = "";
		let bytes = 0;
		for (const entry of this.buf) {
			if (
				(entry.kind === "thinking" || entry.kind === "text") &&
				this.fileBytes + bytes + entry.bytes >= this.eventsCap
			) {
				continue;
			}
			chunk += entry.line;
			bytes += entry.bytes;
		}
		this.buf = [];
		this.bufBytes = 0;
		this.bufKey = "";
		this.lastFlush = Date.now();
		if (!chunk) return;
		try {
			const fd = fs.openSync(this.eventsPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | openNoFollow());
			try {
				fs.writeSync(fd, chunk);
			} finally {
				fs.closeSync(fd);
			}
			this.fileBytes += bytes;
		} catch {
			// Boundary write failed (removed dir, permissions, …) — stop writing
			// events; the agent run and status.json are unaffected.
			this.eventsWritable = false;
		}
	}

	/** Create the stream file empty: O_APPEND|O_CREAT|O_EXCL|O_NOFOLLOW, 0600. */
	private createEventsFile(): void {
		try {
			const fd = fs.openSync(
				this.eventsPath,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | openNoFollow(),
				0o600,
			);
			fs.closeSync(fd);
			try {
				fs.chmodSync(this.eventsPath, 0o600);
			} catch {
				// Best effort on filesystems without POSIX modes.
			}
		} catch {
			this.eventsWritable = false;
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.buf.length === 0) return;
		const wait = Math.max(0, this.flushInterval - (Date.now() - this.lastFlush));
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushEvents();
		}, wait);
		this.flushTimer.unref?.();
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), 200);
		this.timer.unref?.();
	}

	refresh(): void {
		this.writeStatus();
	}

	stopPolling(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		// Terminal run: drain the stream buffer so the tail is complete.
		this.flushEvents();
		this.writeStatus();
	}

	cleanup(): void {
		this.stopPolling();
		try {
			fs.rmSync(this.controlDir, { recursive: true, force: true });
		} catch {}
	}

	private snapshot(): ExternalControlStatus {
		return {
			version: 1,
			runtime: "profiled-subagents",
			agentId: this.agent.agentId,
			profile: this.metadata.profile,
			treeId: this.metadata.treeId,
			parentAgentId: this.metadata.parentAgentId,
			label: this.agent.label,
			state: stateOf(this.agent),
			startedAt: this.agent.startedAt,
			updatedAt: Date.now(),
			...(this.agent.sessionPath ? { sessionPath: this.agent.sessionPath } : {}),
			...(this.agent.model ? { model: this.agent.model } : {}),
			...(this.agent.thinking ? { thinking: this.agent.thinking } : {}),
			...(this.agent.awaitingParent ? { waitingForParent: true } : {}),
		};
	}

	private writeStatus(): void {
		try {
			atomicJson(this.statusPath, this.snapshot());
		} catch {
			// UI integration is best-effort and must never break an agent run.
		}
	}

	private async tick(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			this.writeStatus();
			await this.consumeStop();
			await this.consumeSteers();
			this.writeStatus();
			const state = stateOf(this.agent);
			if (state === "completed" || state === "failed" || state === "stopped") this.stopPolling();
		} finally {
			this.processing = false;
		}
	}

	private async consumeStop(): Promise<void> {
		const filePath = path.join(this.controlDir, "control", "stop.json");
		const raw = readJson(filePath);
		if (!raw) return;
		try {
			fs.rmSync(filePath, { force: true });
		} catch {}
		const request: StopRequest = {
			type: "stop",
			...(typeof raw.id === "string" ? { id: raw.id } : {}),
		};
		if (raw.type !== "stop") {
			if (request.id)
				atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), {
					id: request.id,
					ok: false,
					error: "invalid stop request",
				});
			return;
		}
		try {
			await (this.actions.stop?.() ?? this.agent.stop());
			if (request.id)
				atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), { id: request.id, ok: true, action: "stop" });
		} catch (error) {
			if (request.id)
				atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), {
					id: request.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
		}
	}

	private async consumeSteers(): Promise<void> {
		let names: string[];
		try {
			names = fs
				.readdirSync(this.inbox)
				.filter((name) => name.endsWith(".json"))
				.sort();
		} catch {
			return;
		}
		for (const name of names) {
			const filePath = path.join(this.inbox, name);
			const raw = readJson(filePath);
			try {
				fs.rmSync(filePath, { force: true });
			} catch {}
			if (raw?.type !== "steer" || typeof raw.id !== "string" || typeof raw.message !== "string" || !raw.message.trim())
				continue;
			const request: SteerRequest = { type: "steer", id: raw.id, message: raw.message.trim() };
			let ok = false;
			let error: string | undefined;
			try {
				ok = await (this.actions.steer?.(request.message) ?? this.agent.sendMessage(request.message));
				if (!ok) error = "child rejected steer message";
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}
			atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), {
				id: request.id,
				ok,
				action: "steer",
				...(error ? { error } : {}),
			});
		}
	}
}
