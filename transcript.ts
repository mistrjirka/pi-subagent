import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { formatStamp } from "./time.js";
import type { RenderEvent } from "./types.js";

/**
 * Read-only transcript formatting for live subagent supervision.
 *
 * Pi RPC `get_messages` returns the child's real session messages. Monitoring
 * preserves plaintext thinking when Pi provides it, alongside user/assistant
 * text, tool calls and tool results. Thinking expansion is additive: it does
 * not consume the message/tool selection budget used by supervision views.
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
		typeof part.thinking === "string"
			? part.thinking
			: typeof part.text === "string"
				? part.text
				: undefined;
	return value && value.trim() ? value : undefined;
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
	return { compact: compact.trim(), thinking };
}

function expandThinking(
	projection: TextProjection,
	start = 0,
	end = projection.compact.length,
): string {
	let cursor = start;
	let result = "";
	for (const span of projection.thinking) {
		if (span.end <= start || span.start >= end) continue;
		if (span.start < start || span.end > end) continue;
		result += projection.compact.slice(cursor, span.start);
		result += `[thinking]\n${span.text}`;
		cursor = span.end;
	}
	result += projection.compact.slice(cursor, end);
	return result;
}

function truncateProjection(projection: TextProjection, max: number): { compact: string; detailed: string } {
	if (projection.compact.length <= max)
		return { compact: projection.compact, detailed: expandThinking(projection) };
	const end = Math.max(0, max - 1);
	return {
		compact: `${projection.compact.slice(0, end)}…`,
		detailed: `${expandThinking(projection, 0, end)}…`,
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
	let used = 0;
	for (let i = rendered.length - 1; i >= 0; i--) {
		const line = rendered[i];
		// Budget against the compact marker form, exactly as before raw thinking
		// became visible. Thinking expansion therefore cannot evict tool rows or
		// change which transcript messages survive the supervision window.
		const cost = line.compact.length + (kept.length ? 2 : 0);
		if (kept.length && used + cost > maxChars) break;
		kept.push(line);
		used += cost;
	}
	kept.reverse();
	const omitted = selected.length < messages.length || kept.length < rendered.length;
	return `${omitted ? "[… earlier transcript omitted …]\n\n" : ""}${kept.map((line) => line.detailed).join("\n\n")}`;
}

export interface TranscriptReadableAgent {
	getMessages?: () => Promise<unknown[]>;
	getEvents?: () => RenderEvent[];
	sessionPath?: string;
}

export interface MonitoringTranscript {
	text: string;
	source: "rpc" | "session" | "events" | "none";
	rpcError?: string;
}

export function recentSessionMessages(sessionPath: string, maxBytes = 512 * 1024): unknown[] {
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
		const messages: unknown[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { type?: unknown; message?: unknown; timestamp?: unknown };
				if (entry.type === "message" && entry.message && typeof entry.message === "object") {
					// The session record's own ISO time is the only clock on this
					// path — the inner message carries none, so attach it additively
					// (a copy; the record is never mutated) when the message itself
					// lacks a usable time. Malformed times are dropped, never thrown.
					const recordMs = normalizeTimestamp(entry.timestamp);
					const inner = entry.message as Record<string, unknown>;
					messages.push(
						recordMs !== undefined && messageTimestampMs(inner) === undefined
							? { ...inner, timestamp: recordMs }
							: entry.message,
					);
				}
			} catch {
				// A concurrently-appended final line can be partial; ignore it.
			}
		}
		return messages;
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
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
				detailed: event.text && event.text.trim() ? `${compact}\n${event.text}` : compact,
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
	if (compact.length <= maxChars) return expandThinking(combined);
	const start = compact.length - maxChars;
	return `[… earlier live events omitted …]\n\n${expandThinking(combined, start)}`;
}

export async function getMonitoringTranscript(
	agent: TranscriptReadableAgent,
	options: TranscriptFormatOptions = {},
): Promise<MonitoringTranscript> {
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
				text: prefix + formatTranscript(persisted, options),
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
		return { text: prefix + formatRecentActivity(events), source: "events", ...(rpcError ? { rpcError } : {}) };
	}

	return {
		text: rpcError
			? `[transcript unavailable: ${rpcError}; no persisted/session event fallback available]`
			: "[no transcript messages yet]",
		source: "none",
		...(rpcError ? { rpcError } : {}),
	};
}
