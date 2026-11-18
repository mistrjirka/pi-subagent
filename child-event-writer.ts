/**
 * Bounded append-only child stream writer.
 *
 * Owns file creation, assistant-message boundaries, event coalescing,
 * cap enforcement and delayed flush. It never changes child lifecycle or
 * publishes status, and all I/O failures remain best effort.
 */
import * as fs from "node:fs";
import type { AgentEvent } from "./event-interpret.js";

/** O_NOFOLLOW where the platform defines it (0 elsewhere — open still applies). */
function openNoFollow(): number {
	return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

/**
 * Map one interpreted event onto an `events.jsonl` record. Undefined = no new
 * stream content (settle/message/question/tree/failure and model argument
 * generation). Tool lifecycle rows come only from actual execution events. Block identity derives from the
 * wire contentIndex so consecutive lines sharing (runId, blockId) accumulate
 * into one in-flight item on the reader side.
 */
function toStreamRecord(event: AgentEvent):
	| {
			kind: ChildStreamLine["kind"];
			blockId?: string;
			text?: string;
			toolName?: string;
			toolCallId?: string;
			argsPreview?: string;
			timeoutSeconds?: number;
			isError?: boolean;
	  }
	| undefined {
	switch (event.type) {
		case "thinking":
			if (event.text === undefined) return undefined;
			return { kind: "thinking", blockId: `think-${event.contentIndex ?? 0}`, text: event.text };
		case "text_delta":
			return { kind: "text", blockId: `text-${event.contentIndex ?? 0}`, text: event.delta };
		case "tool_execution_start":
			return {
				kind: "tool_start",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				argsPreview: event.argsPreview,
				...(event.timeoutSeconds !== undefined ? { timeoutSeconds: event.timeoutSeconds } : {}),
			};
		case "tool_execution_end":
			return { kind: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
		case "tool_result_end":
			return { kind: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
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
	/** 1-based assistant message sequence. Optional for backward compatibility. */
	messageSeq?: number;
	kind: "thinking" | "text" | "tool_start" | "tool_end";
	blockId?: string;
	text?: string;
	toolName?: string;
	toolCallId?: string;
	argsPreview?: string;
	timeoutSeconds?: number;
	isError?: boolean;
}

const EVENTS_CAP_BYTES = 2 * 1024 * 1024;
const EVENTS_FLUSH_MS = 250;
const EVENTS_BUFFER_BYTES = 4 * 1024;

export class ChildEventWriter {
	private seq = 0;
	private assistantMessageSeq = 0;
	private currentAssistantMessageSeq: number | undefined;
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
		readonly eventsPath: string,
		private readonly runId: string,
		options: ExternalControlOptions = {},
	) {
		this.eventsCap = options.eventsCapBytes ?? EVENTS_CAP_BYTES;
		this.flushInterval = options.flushIntervalMs ?? EVENTS_FLUSH_MS;
		this.maxBuffered = options.maxBufferedBytes ?? EVENTS_BUFFER_BYTES;
		this.createEventsFile();
	}

	append(event: AgentEvent): void {
		if (!this.eventsWritable) return;
		if (event.type === "assistant_start") {
			// A contentIndex such as think-0/text-1 is only unique inside one
			// assistant message. Flush any previous buffer before advancing the
			// turn so equal block ids from adjacent messages never coalesce.
			this.flush();
			this.currentAssistantMessageSeq = ++this.assistantMessageSeq;
			return;
		}
		if (event.type === "assistant_end") {
			this.flush();
			this.currentAssistantMessageSeq = undefined;
			return;
		}
		const record = toStreamRecord(event);
		if (!record) return;
		// 2 MB cap: drop thinking/text, keep tool_start/tool_end.
		if ((record.kind === "thinking" || record.kind === "text") && this.fileBytes >= this.eventsCap) return;
		const key = `${this.currentAssistantMessageSeq ?? 0}\0${record.kind}\0${record.blockId ?? ""}`;
		// Flush when the kind (or blockId) changes so a reader never sees a
		// stale open block interleaved with a new one.
		if (this.buf.length > 0 && key !== this.bufKey) this.flush();
		this.seq += 1;
		const line: ChildStreamLine = {
			v: 1,
			seq: this.seq,
			ts: Date.now(),
			runId: this.runId,
			...(this.currentAssistantMessageSeq !== undefined ? { messageSeq: this.currentAssistantMessageSeq } : {}),
			kind: record.kind,
			...(record.blockId !== undefined ? { blockId: record.blockId } : {}),
			...(record.text !== undefined ? { text: record.text } : {}),
			...(record.toolName !== undefined ? { toolName: record.toolName } : {}),
			...(record.toolCallId !== undefined ? { toolCallId: record.toolCallId } : {}),
			...(record.argsPreview !== undefined ? { argsPreview: record.argsPreview } : {}),
			...(record.timeoutSeconds !== undefined ? { timeoutSeconds: record.timeoutSeconds } : {}),
			...(record.isError !== undefined ? { isError: record.isError } : {}),
		};
		const serialized = `${JSON.stringify(line)}\n`;
		const bytes = Buffer.byteLength(serialized, "utf8");
		this.buf.push({ line: serialized, kind: record.kind, bytes });
		this.bufBytes += bytes;
		this.bufKey = key;
		if (this.bufBytes >= this.maxBuffered) {
			this.flush();
		} else if (Date.now() - this.lastFlush >= this.flushInterval) {
			this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	/** Write the buffered lines (one O_APPEND open per flush, never per token, never fsync). */
	flush(): void {
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
			this.flush();
		}, wait);
		this.flushTimer.unref?.();
	}
}
