import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { formatStamp } from "./time.js";
import type { RenderEvent } from "./types.js";

/**
 * Read-only transcript formatting for live subagent supervision.
 *
 * Pi RPC `get_messages` returns the child's real session messages. Monitoring
 * preserves plaintext thinking when the provider exposes it, alongside the
 * existing user/assistant text, tool calls and tool results.
 *
 * Thinking is additive to the old compact representation: transcript/message
 * selection and tool visibility are budgeted from the marker-only form first,
 * then the full thinking bodies are inserted. Showing reasoning therefore
 * cannot reduce the number of tool calls/results the same limits showed before.
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

function thinkingText(part: Record<string, unknown>): string {
	for (const key of ["thinking", "text", "content"] as const) {
		const value = part[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function contentText(content: unknown, includeToolCalls: boolean): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
			continue;
		}
		if (part.type === "image") {
			parts.push("[image]");
			continue;
		}
		if (part.type === "thinking") {
			parts.push("[thinking]");
			continue;
		}
		if (includeToolCalls && part.type === "toolCall" && typeof part.name === "string") {
			const args = part.arguments === undefined ? "" : ` ${jsonCompact(part.arguments)}`;
			parts.push(`[tool call] ${part.name}${args}`);
		}
	}
	return parts.join("\n").trim();
}

function thinkingBodies(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const bodies: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as Record<string, unknown>;
		if (part.type !== "thinking") continue;
		bodies.push(thinkingText(part));
	}
	return bodies;
}

/**
 * Expand marker-only thinking additively. The compact string is already the
 * exact pre-v0.5.3 representation after per-message truncation, so inserting
 * bodies here cannot hide/reorder a tool call that was previously visible.
 */
function expandThinkingMarkers(compact: string, bodies: readonly string[]): string {
	if (!bodies.length || !compact.includes("[thinking]")) return compact;
	let index = 0;
	return compact.replaceAll("[thinking]", () => {
		const body = bodies[index++] ?? "";
		return body ? `[thinking]\n${body}` : "[thinking]";
	});
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

function formatTranscriptMessageCompact(
	message: unknown,
	perMessageChars = DEFAULT_PER_MESSAGE_CHARS,
	timestampMs?: number,
	nowMs: number = Date.now(),
): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const prefix =
		timestampMs !== undefined && Number.isFinite(timestampMs) ? `[${formatStamp(timestampMs, nowMs)}] ` : "";
	const msg = message as Record<string, unknown>;
	const role = msg.role;
	if (role === "user") {
		const text = contentText(msg.content, false);
		return text ? `${prefix}user: ${truncate(text, perMessageChars)}` : `${prefix}user: [no text]`;
	}
	if (role === "assistant") {
		const text = contentText(msg.content, true);
		const suffix = typeof msg.errorMessage === "string" && msg.errorMessage ? `\n[error] ${msg.errorMessage}` : "";
		return `${prefix}assistant: ${truncate(text || "[no text yet]", perMessageChars)}${suffix}`;
	}
	if (role === "toolResult") {
		const tool = typeof msg.toolName === "string" ? msg.toolName : "tool";
		const error = msg.isError === true ? " ERROR" : "";
		const text = contentText(msg.content, false);
		return `${prefix}tool result (${tool}${error}): ${truncate(text || "[no text]", perMessageChars)}`;
	}
	return undefined;
}

export function formatTranscriptMessage(
	message: unknown,
	perMessageChars = DEFAULT_PER_MESSAGE_CHARS,
	timestampMs?: number,
	nowMs: number = Date.now(),
): string | undefined {
	const compact = formatTranscriptMessageCompact(message, perMessageChars, timestampMs, nowMs);
	if (!compact || !message || typeof message !== "object") return compact;
	const msg = message as Record<string, unknown>;
	return msg.role === "assistant"
		? expandThinkingMarkers(compact, thinkingBodies(msg.content))
		: compact;
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
			// the formatters only ever see a finite epoch-ms or nothing.
			const timestampMs =
				message && typeof message === "object" ? messageTimestampMs(message as Record<string, unknown>) : undefined;
			const compact = formatTranscriptMessageCompact(message, perMessageChars, timestampMs, nowMs);
			const expanded = formatTranscriptMessage(message, perMessageChars, timestampMs, nowMs);
			return compact && expanded ? { compact, expanded } : undefined;
		})
		.filter((line): line is { compact: string; expanded: string } => Boolean(line));
	if (!rendered.length) return "[no transcript messages yet]";

	// Keep exactly the same message/tool set the marker-only transcript would
	// have kept. Full thinking is additive and does not consume this budget.
	const kept: { compact: string; expanded: string }[] = [];
	let used = 0;
	for (let i = rendered.length - 1; i >= 0; i--) {
		const line = rendered[i];
		const cost = line.compact.length + (kept.length ? 2 : 0);
		if (kept.length && used + cost > maxChars) break;
		kept.push(line);
		used += cost;
	}
	kept.reverse();
	const omitted = selected.length < messages.length || kept.length < rendered.length;
	return `${omitted ? "[… earlier transcript omitted …]\n\n" : ""}${kept.map((line) => line.expanded).join("\n\n")}`;
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
	const selected = events.slice(-maxEvents);
	const compact = selected.map((event) => {
		// Events reconstructed from older data carry no ts — they render
		// exactly as before (no empty brackets).
		const prefix =
			typeof event.ts === "number" && Number.isFinite(event.ts) ? `[${formatStamp(event.ts, nowMs)}] ` : "";
		if (event.kind === "thinking") return `${prefix}[thinking]`;
		if (event.kind === "tool") return `${prefix}[tool call] ${event.name}${event.args ? ` ${event.args}` : ""}`;
		return `${prefix}assistant: ${event.text}`;
	});
	if (!compact.length) return "[no live event transcript yet]";

	let baseline = compact.join("\n\n");
	if (baseline.length > maxChars) baseline = `[… earlier live events omitted …]\n\n${baseline.slice(-maxChars)}`;

	// Preserve the exact compact/tool trail selected by the old budget, then
	// expand only the thinking markers that survived that trail.
	const markerCount = baseline.split("[thinking]").length - 1;
	if (markerCount <= 0) return baseline;
	const bodies = selected
		.filter((event): event is Extract<RenderEvent, { kind: "thinking" }> => event.kind === "thinking")
		.map((event) => event.text ?? "")
		.slice(-markerCount);
	return expandThinkingMarkers(baseline, bodies);
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
