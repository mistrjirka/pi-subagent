/**
 * Read-only transcript formatting for live subagent supervision.
 *
 * Pi RPC `get_messages` returns the child's real session messages. Monitoring
 * deliberately omits raw thinking text: user/assistant text, tool calls and
 * tool results are sufficient to judge progress without copying reasoning.
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

export function formatTranscriptMessage(
	message: unknown,
	perMessageChars = DEFAULT_PER_MESSAGE_CHARS,
): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const msg = message as Record<string, unknown>;
	const role = msg.role;
	if (role === "user") {
		const text = contentText(msg.content, false);
		return text ? `user: ${truncate(text, perMessageChars)}` : "user: [no text]";
	}
	if (role === "assistant") {
		const text = contentText(msg.content, true);
		const suffix = typeof msg.errorMessage === "string" && msg.errorMessage ? `\n[error] ${msg.errorMessage}` : "";
		return `assistant: ${truncate(text || "[no text yet]", perMessageChars)}${suffix}`;
	}
	if (role === "toolResult") {
		const tool = typeof msg.toolName === "string" ? msg.toolName : "tool";
		const error = msg.isError === true ? " ERROR" : "";
		const text = contentText(msg.content, false);
		return `tool result (${tool}${error}): ${truncate(text || "[no text]", perMessageChars)}`;
	}
	return undefined;
}

export function formatTranscript(messages: readonly unknown[], options: TranscriptFormatOptions = {}): string {
	const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
	const maxChars = Math.max(256, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
	const perMessageChars = Math.max(128, Math.floor(options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS));
	const selected = messages.slice(-maxMessages);
	const rendered = selected
		.map((message) => formatTranscriptMessage(message, perMessageChars))
		.filter((line): line is string => Boolean(line));
	if (!rendered.length) return "[no transcript messages yet]";

	const kept: string[] = [];
	let used = 0;
	for (let i = rendered.length - 1; i >= 0; i--) {
		const line = rendered[i];
		const cost = line.length + (kept.length ? 2 : 0);
		if (kept.length && used + cost > maxChars) break;
		kept.push(line);
		used += cost;
	}
	kept.reverse();
	const omitted = selected.length < messages.length || kept.length < rendered.length;
	return `${omitted ? "[… earlier transcript omitted …]\n\n" : ""}${kept.join("\n\n")}`;
}
