import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SessionEntryCursor } from "./session-transcript.js";
import { formatStamp } from "./time.js";
import type { RenderEvent } from "./types.js";

/**
 * Read-only transcript formatting for live subagent supervision.
 *
 * Pi RPC `get_messages` returns the child's real session messages. Monitoring
 * preserves plaintext thinking when Pi provides it, alongside user/assistant
 * text, tool calls and tool results. Parent-facing output, including thinking and omission markers, is bounded
 * by the final character budget. Full UI/session traces remain available.
 */

export interface TranscriptFormatOptions {
	maxMessages?: number;
	maxChars?: number;
	perMessageChars?: number;
}

const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_PER_MESSAGE_CHARS = 2_000;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function jsonCompact(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable arguments]";
	}
}

type ThinkingSpan = { start: number; end: number; text: string };

type TextProjection = {
	compact: string;
	thinking: ThinkingSpan[];
};

function thinkingText(part: Record<string, unknown>): string | undefined {
	const value =
		typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : undefined;
	return value?.trim() ? value : undefined;
}

function contentProjection(content: unknown, includeToolCalls: boolean): TextProjection {
	if (typeof content === "string") return { compact: content, thinking: [] };
	if (!Array.isArray(content)) return { compact: "", thinking: [] };
	let compact = "";
	const thinking: ThinkingSpan[] = [];
	const append = (text: string, thought?: string) => {
		if (compact) compact += "\n";
		const start = compact.length;
		compact += text;
		if (thought) thinking.push({ start, end: compact.length, text: thought });
	};
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") {
			append(part.text);
			continue;
		}
		if (part.type === "image") {
			append("[image]");
			continue;
		}
		if (part.type === "thinking") {
			append("[thinking]", thinkingText(part));
			continue;
		}
		if (includeToolCalls && part.type === "toolCall" && typeof part.name === "string") {
			const args = part.arguments === undefined ? "" : ` ${jsonCompact(part.arguments)}`;
			append(`[tool call] ${part.name}${args}`);
		}
	}
	const trimmed = compact.trim();
	if (trimmed === compact) return { compact, thinking };
	const leading = compact.length - compact.trimStart().length;
	const trailingEnd = leading + trimmed.length;
	return {
		compact: trimmed,
		thinking: thinking
			.filter((span) => span.start >= leading && span.end <= trailingEnd)
			.map((span) => ({
				start: span.start - leading,
				end: span.end - leading,
				text: span.text,
			})),
	};
}

function expandThinking(
	projection: TextProjection,
	start = 0,
	end = projection.compact.length,
	maxChars = DEFAULT_PER_MESSAGE_CHARS,
): string {
	let extra = Math.max(0, maxChars - (end - start));
	let cursor = start;
	let result = "";
	for (const span of projection.thinking) {
		if (span.end <= start || span.start >= end) continue;
		if (span.start < start || span.end > end) continue;
		result += projection.compact.slice(cursor, span.start);
		const thought = extra > 1 ? truncate(span.text, extra - 1) : "";
		result += `[thinking]${thought ? `\n${thought}` : ""}`;
		extra -= thought.length + (thought ? 1 : 0);
		cursor = span.end;
	}
	result += projection.compact.slice(cursor, end);
	return truncate(result, maxChars);
}

function truncateProjection(projection: TextProjection, max: number): { compact: string; detailed: string } {
	if (projection.compact.length <= max)
		return { compact: projection.compact, detailed: expandThinking(projection, 0, projection.compact.length, max) };
	const end = Math.max(0, max - 1);
	return {
		compact: `${projection.compact.slice(0, end)}…`,
		detailed: `${expandThinking(projection, 0, end, max - 1)}…`,
	};
}

/**
 * Narrow an untrusted timestamp value to epoch-ms. Accepts a finite numeric
 * epoch-ms or a parseable date string; anything else (NaN, Infinity,
 * garbage, objects) is ignored. The `unknown` stays at this boundary.
 */
function normalizeTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** Derive a message's epoch-ms once: `timestamp` / `ts` / `createdAt`. */
function messageTimestampMs(message: Record<string, unknown>): number | undefined {
	return (
		normalizeTimestamp(message.timestamp) ?? normalizeTimestamp(message.ts) ?? normalizeTimestamp(message.createdAt)
	);
}

type TranscriptLineProjection = {
	compact: string;
	detailed: string;
};

function formatTranscriptMessageProjection(
	message: unknown,
	perMessageChars = DEFAULT_PER_MESSAGE_CHARS,
	timestampMs?: number,
	nowMs: number = Date.now(),
): TranscriptLineProjection | undefined {
	if (!message || typeof message !== "object") return undefined;
	const prefix =
		timestampMs !== undefined && Number.isFinite(timestampMs) ? `[${formatStamp(timestampMs, nowMs)}] ` : "";
	const msg = message as Record<string, unknown>;
	const role = msg.role;
	if (role === "user") {
		const projection = contentProjection(msg.content, false);
		const text = projection.compact;
		const compact = text ? truncate(text, perMessageChars) : "[no text]";
		return { compact: `${prefix}user: ${compact}`, detailed: `${prefix}user: ${compact}` };
	}
	if (role === "assistant") {
		const projection = contentProjection(msg.content, true);
		const suffix = typeof msg.errorMessage === "string" && msg.errorMessage ? `\n[error] ${msg.errorMessage}` : "";
		if (!projection.compact) {
			const line = `${prefix}assistant: [no text yet]${suffix}`;
			return { compact: line, detailed: line };
		}
		const body = truncateProjection(projection, perMessageChars);
		return {
			compact: `${prefix}assistant: ${body.compact}${suffix}`,
			detailed: `${prefix}assistant: ${body.detailed}${suffix}`,
		};
	}
	if (role === "toolResult") {
		const tool = typeof msg.toolName === "string" ? msg.toolName : "tool";
		const error = msg.isError === true ? " ERROR" : "";
		const projection = contentProjection(msg.content, false);
		const text = projection.compact;
		const body = truncate(text || "[no text]", perMessageChars);
		const line = `${prefix}tool result (${tool}${error}): ${body}`;
		return { compact: line, detailed: line };
	}
	return undefined;
}

export function formatTranscriptMessage(
	message: unknown,
	perMessageChars = DEFAULT_PER_MESSAGE_CHARS,
	timestampMs?: number,
	nowMs: number = Date.now(),
): string | undefined {
	return formatTranscriptMessageProjection(message, perMessageChars, timestampMs, nowMs)?.detailed;
}

export function formatTranscript(
	messages: readonly unknown[],
	options: TranscriptFormatOptions = {},
	nowMs: number = Date.now(),
): string {
	const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
	const maxChars = Math.max(256, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
	const perMessageChars = Math.max(128, Math.floor(options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS));
	const selected = messages.slice(-maxMessages);
	const rendered = selected
		.map((message) => {
			// Derived once per message — the timestamp narrowing lives here so
			// formatTranscriptMessage only ever sees a finite epoch-ms or nothing.
			const timestampMs =
				message && typeof message === "object" ? messageTimestampMs(message as Record<string, unknown>) : undefined;
			return formatTranscriptMessageProjection(message, perMessageChars, timestampMs, nowMs);
		})
		.filter((line): line is TranscriptLineProjection => Boolean(line));
	if (!rendered.length) return "[no transcript messages yet]";

	const kept: TranscriptLineProjection[] = [];
	let used = "[… earlier transcript omitted …]\n\n".length;
	for (let i = rendered.length - 1; i >= 0; i--) {
		const line = rendered[i];
		// Charge the text actually returned, including bounded thinking.
		const cost = line.detailed.length + (kept.length ? 2 : 0);
		if (kept.length && used + cost > maxChars) break;
		kept.push(line);
		used += cost;
	}
	kept.reverse();
	const omitted = selected.length < messages.length || kept.length < rendered.length;
	return truncate(
		`${omitted ? "[… earlier transcript omitted …]\n\n" : ""}${kept.map((line) => line.detailed).join("\n\n")}`,
		maxChars,
	);
}

export interface TranscriptReadableAgent {
	getMessages?: () => Promise<unknown[]>;
	/** Append-ordered Pi session entries; `since` is a stable entry-id cursor. */
	getEntries?: (since?: string) => Promise<{ entries: unknown[]; leafId: string | null }>;
	getEvents?: () => RenderEvent[];
	sessionPath?: string;
}

export interface MonitoringTranscript {
	text: string;
	source: "rpc" | "session" | "events" | "none";
	rpcError?: string;
}

export interface IncrementalMonitoringTranscript extends MonitoringTranscript {
	/** Number of previously-unseen transcript messages returned by this read. */
	returnedMessages: number;
	/** Number of already-fetched unread messages left behind the page boundary. */
	remainingMessages: number;
	/** False when a bounded local read knows only a lower bound. */
	remainingMessagesExact?: boolean;
	hasMore: boolean;
	/** Stable session entry id through which this read may advance. */
	nextCursor?: string;
	/** Stable IDs of messages actually returned, for cross-tool de-duplication. */
	shownEntryIds?: string[];
}

function sessionEntryId(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const id = (entry as Record<string, unknown>).id;
	return typeof id === "string" && id ? id : undefined;
}

/** Project one persisted/RPC session entry onto the same message shape get_messages returns. */
function sessionMessageFromEntry(entry: unknown): unknown | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return undefined;
	const inner = record.message as Record<string, unknown>;
	const recordMs = normalizeTimestamp(record.timestamp);
	return recordMs !== undefined && messageTimestampMs(inner) === undefined
		? { ...inner, timestamp: recordMs }
		: record.message;
}

function renderUnreadEntryPage(
	entries: readonly unknown[],
	options: TranscriptFormatOptions = {},
	nowMs: number = Date.now(),
	alreadyShown?: ReadonlySet<string>,
): Omit<IncrementalMonitoringTranscript, "source" | "rpcError"> {
	const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
	const maxChars = Math.max(256, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
	const perMessageChars = Math.max(128, Math.floor(options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS));
	const rendered: Array<{ entryId: string; line: TranscriptLineProjection }> = [];

	for (const entry of entries) {
		const message = sessionMessageFromEntry(entry);
		if (message === undefined) continue;
		const entryId = sessionEntryId(entry);
		if (!entryId) throw new Error("get_entries returned a message entry without an id");
		if (alreadyShown?.has(entryId)) continue;
		const timestampMs =
			message && typeof message === "object" ? messageTimestampMs(message as Record<string, unknown>) : undefined;
		const line = formatTranscriptMessageProjection(message, perMessageChars, timestampMs, nowMs);
		if (line) rendered.push({ entryId, line });
	}

	const lastEntryId = [...entries]
		.reverse()
		.map(sessionEntryId)
		.find((id): id is string => Boolean(id));
	if (!rendered.length) {
		return {
			text: "[no new transcript messages]",
			returnedMessages: 0,
			remainingMessages: 0,
			hasMore: false,
			shownEntryIds: [],
			...(lastEntryId ? { nextCursor: lastEntryId } : {}),
		};
	}

	const kept: Array<{ entryId: string; line: TranscriptLineProjection }> = [];
	let used = 0;
	for (const item of rendered) {
		if (kept.length >= maxMessages) break;
		const cost = item.line.detailed.length + (kept.length ? 2 : 0);
		if (kept.length && used + cost > maxChars) break;
		kept.push(item);
		used += cost;
	}

	const remainingMessages = rendered.length - kept.length;
	const lastKept = kept[kept.length - 1];
	const nextCursor = remainingMessages > 0 ? lastKept.entryId : (lastEntryId ?? lastKept.entryId);
	const suffix =
		remainingMessages > 0
			? `\n\n[… ${remainingMessages} unread transcript message${remainingMessages === 1 ? "" : "s"} remain …]`
			: "";
	return {
		text: truncate(kept.map((item) => item.line.detailed).join("\n\n") + suffix, maxChars),
		returnedMessages: kept.length,
		remainingMessages,
		hasMore: remainingMessages > 0,
		nextCursor,
		shownEntryIds: kept.map((item) => item.entryId),
	};
}

async function getIncrementalMonitoringTranscript(
	agent: TranscriptReadableAgent,
	since: string | undefined,
	options: TranscriptFormatOptions,
	sessionCursor: SessionEntryCursor,
	alreadyShown?: ReadonlySet<string>,
): Promise<IncrementalMonitoringTranscript> {
	if (agent.sessionPath) {
		try {
			const page = sessionCursor.read(agent.sessionPath, Math.max(1, options.maxMessages ?? DEFAULT_MAX_MESSAGES) + 1);
			const formatted = renderUnreadEntryPage(page.entries, options, Date.now(), alreadyShown);
			sessionCursor.commit(formatted.nextCursor);
			return {
				...formatted,
				source: "session",
				hasMore: formatted.hasMore || page.hasMore,
				remainingMessages: Math.max(formatted.remainingMessages, page.hasMore ? 1 : 0),
				remainingMessagesExact: !page.hasMore,
			};
		} catch (error) {
			// An inaccessible file can use RPC; malformed/oversized persisted data
			// must remain an explicit error instead of another oversized fetch.
			if (!(error instanceof Error && "code" in error && ["ENOENT", "EACCES"].includes(String(error.code)))) {
				const rpcError = error instanceof Error ? error.message : String(error);
				return {
					text: `[incremental transcript unavailable: ${rpcError}]`,
					source: "none",
					rpcError,
					returnedMessages: 0,
					remainingMessages: 0,
					hasMore: false,
				};
			}
		}
	}
	if (!agent.getEntries) {
		const rpcError = "child runtime does not expose get_entries";
		return {
			text: `[incremental transcript unavailable: ${rpcError}]`,
			source: "none",
			rpcError,
			returnedMessages: 0,
			remainingMessages: 0,
			hasMore: false,
		};
	}
	try {
		const page = await agent.getEntries(since);
		return { ...renderUnreadEntryPage(page.entries, options, Date.now(), alreadyShown), source: "rpc" };
	} catch (error) {
		const rpcError = error instanceof Error ? error.message : String(error);
		return {
			text: `[incremental transcript unavailable: ${rpcError}]`,
			source: "none",
			rpcError,
			returnedMessages: 0,
			remainingMessages: 0,
			hasMore: false,
		};
	}
}

/**
 * Shared parent-side read cursor for one child. Reads are serialized so
 * concurrent agent_wait / agent_inspect calls cannot consume the same page.
 */
export class IncrementalTranscriptCursor {
	private afterEntryId: string | undefined;
	private latestEntryId: string | undefined;
	private readonly shownRecentIds = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private readonly sessionCursor = new SessionEntryCursor();

	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	/** Backfill oldest unread history. Messages already surfaced in a recent wait are skipped. */
	read(
		agent: TranscriptReadableAgent,
		options: TranscriptFormatOptions = {},
	): Promise<IncrementalMonitoringTranscript> {
		return this.serialize(async () => {
			const snapshot = await getIncrementalMonitoringTranscript(
				agent, this.afterEntryId, options, this.sessionCursor, this.shownRecentIds,
			);
			if (snapshot.nextCursor) this.afterEntryId = snapshot.nextCursor;
			for (const id of snapshot.shownEntryIds ?? []) this.shownRecentIds.add(id);
			return snapshot;
		});
	}

	/**
	 * Supervision prioritizes new progress rather than repeatedly reading the start of a
	 * long backlog. The older cursor stays untouched for agent_inspect.
	 * A bounded session tail avoids fetching the whole child conversation over RPC.
	 */
	readRecent(
		agent: TranscriptReadableAgent,
		options: TranscriptFormatOptions = {},
	): Promise<IncrementalMonitoringTranscript> {
		return this.serialize(async () => {
			if (!agent.sessionPath) {
				// Older runtimes without a session file retain the safe incremental fallback.
				const snapshot = await getIncrementalMonitoringTranscript(
					agent, this.afterEntryId, options, this.sessionCursor, this.shownRecentIds,
				);
				if (snapshot.nextCursor) this.afterEntryId = snapshot.nextCursor;
				for (const id of snapshot.shownEntryIds ?? []) this.shownRecentIds.add(id);
				return snapshot;
			}
			const entries = recentSessionRecords(agent.sessionPath).filter(
				(entry): entry is Record<string, unknown> =>
					Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message"
						&& sessionEntryId(entry)),
			);
			if (!entries.length) {
				// An inaccessible or not-yet-complete session may still be available by RPC.
				const snapshot = await getIncrementalMonitoringTranscript(
					agent, this.afterEntryId, options, this.sessionCursor, this.shownRecentIds,
				);
				if (snapshot.nextCursor) this.afterEntryId = snapshot.nextCursor;
				for (const id of snapshot.shownEntryIds ?? []) this.shownRecentIds.add(id);
				return snapshot;
			}
			const lastIndex = this.latestEntryId ? entries.findIndex((entry) => entry.id === this.latestEntryId) : -1;
			const fresh = entries.slice(lastIndex + 1).filter((entry) => !this.shownRecentIds.has(entry.id as string));
			// Do not regress to older entries when the child produces nothing new.
			this.latestEntryId = entries.at(-1)?.id as string;
			const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
			const maxChars = Math.max(256, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
			const perMessageChars = Math.max(128, Math.floor(options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS));
			const lines: string[] = [];
			let used = 0;
			for (const entry of fresh.reverse()) {
				if (lines.length >= maxMessages) break;
				const message = sessionMessageFromEntry(entry);
				const timestampMs = message && typeof message === "object"
					? messageTimestampMs(message as Record<string, unknown>) : undefined;
				const line = formatTranscriptMessageProjection(message, perMessageChars, timestampMs);
				if (!line) continue;
				const cost = line.detailed.length + (lines.length ? 2 : 0);
				if (lines.length && used + cost > maxChars) break;
				lines.push(line.detailed);
				used += cost;
				this.shownRecentIds.add(entry.id as string);
			}
			const remainingMessages = fresh.length - lines.length;
			return {
				text: lines.length ? truncate(lines.join("\n\n"), maxChars) : "[no new recent transcript messages]",
				source: "session",
				returnedMessages: lines.length,
				remainingMessages,
				remainingMessagesExact: false,
				hasMore: remainingMessages > 0,
			};
		});
	}
}

function recentSessionRecords(sessionPath: string, maxBytes = 512 * 1024): unknown[] {
	let fd: number | undefined;
	try {
		fd = openSync(sessionPath, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return [];
		const buffer = Buffer.allocUnsafe(length);
		const read = readSync(fd, buffer, 0, length, start);
		let text = buffer.subarray(0, read).toString("utf8");
		if (start > 0) {
			const firstNl = text.indexOf("\n");
			text = firstNl >= 0 ? text.slice(firstNl + 1) : "";
		}
		const records: unknown[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// A concurrently-appended final line can be partial; ignore it.
			}
		}
		return records;
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}


export function recentSessionMessages(sessionPath: string, maxBytes = 512 * 1024): unknown[] {
	return recentSessionRecords(sessionPath, maxBytes)
		.map(sessionMessageFromEntry)
		.filter((message) => message !== undefined);
}

export function formatRecentActivity(
	events: readonly RenderEvent[],
	maxEvents = 20,
	maxChars = 4_000,
	nowMs: number = Date.now(),
): string {
	const projections = events.slice(-maxEvents).map((event): TranscriptLineProjection => {
		// Events reconstructed from older data carry no ts — they render
		// exactly as before (no empty brackets).
		const prefix =
			typeof event.ts === "number" && Number.isFinite(event.ts) ? `[${formatStamp(event.ts, nowMs)}] ` : "";
		if (event.kind === "thinking") {
			const compact = `${prefix}[thinking]`;
			return {
				compact,
				detailed: event.text?.trim() ? `${compact}\n${event.text}` : compact,
			};
		}
		if (event.kind === "tool") {
			const line = `${prefix}[tool call] ${event.name}${event.args ? ` ${event.args}` : ""}`;
			return { compact: line, detailed: line };
		}
		const line = `${prefix}assistant: ${event.text}`;
		return { compact: line, detailed: line };
	});
	if (!projections.length) return "[no live event transcript yet]";

	let compact = "";
	const thinking: ThinkingSpan[] = [];
	for (const projection of projections) {
		if (compact) compact += "\n\n";
		const offset = compact.length;
		compact += projection.compact;
		if (projection.detailed !== projection.compact) {
			const marker = projection.compact.lastIndexOf("[thinking]");
			if (marker >= 0) {
				thinking.push({
					start: offset + marker,
					end: offset + marker + "[thinking]".length,
					text: projection.detailed.slice(projection.compact.length + 1),
				});
			}
		}
	}
	const combined: TextProjection = { compact, thinking };
	if (compact.length <= maxChars) return expandThinking(combined, 0, compact.length, maxChars);
	const start = compact.length - maxChars;
	return truncate(
		`[… earlier live events omitted …]\n\n${expandThinking(combined, start, compact.length, maxChars)}`,
		maxChars,
	);
}

export async function getMonitoringTranscript(
	agent: TranscriptReadableAgent,
	options: TranscriptFormatOptions = {},
): Promise<MonitoringTranscript> {
	if (agent.sessionPath) {
		const persisted = recentSessionMessages(agent.sessionPath);
		if (persisted.length) return { text: formatTranscript(persisted, options), source: "session" };
	}
	let rpcError: string | undefined;
	if (agent.getMessages) {
		try {
			const messages = await agent.getMessages();
			if (messages.length) return { text: formatTranscript(messages, options), source: "rpc" };
		} catch (error) {
			rpcError = error instanceof Error ? error.message : String(error);
		}
	}

	if (agent.sessionPath) {
		const persisted = recentSessionMessages(agent.sessionPath);
		if (persisted.length) {
			const prefix = rpcError
				? `[live get_messages unavailable: ${rpcError}; showing persisted session fallback]\n\n`
				: "[showing persisted session fallback]\n\n";
			return {
				text: truncate(prefix + formatTranscript(persisted, options), options.maxChars ?? DEFAULT_MAX_CHARS),
				source: "session",
				...(rpcError ? { rpcError } : {}),
			};
		}
	}

	const events = agent.getEvents?.() ?? [];
	if (events.length) {
		const prefix = rpcError
			? `[live get_messages unavailable: ${rpcError}; showing live event fallback]\n\n`
			: "[live Pi message transcript is empty; showing live event fallback]\n\n";
		return {
			text: truncate(
				prefix + formatRecentActivity(events, options.maxMessages, options.maxChars),
				options.maxChars ?? DEFAULT_MAX_CHARS,
			),
			source: "events",
			...(rpcError ? { rpcError } : {}),
		};
	}

	return {
		text: rpcError
			? `[transcript unavailable: ${rpcError}; no persisted/session event fallback available]`
			: "[no transcript messages yet]",
		source: "none",
		...(rpcError ? { rpcError } : {}),
	};
}
