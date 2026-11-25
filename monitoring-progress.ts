import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RpcEvent } from "./protocol.js";

const MAX_FILES_SHOWN = 8;
const MAX_PATH_CHARS = 120;

export interface MonitoringProgress {
	tools: number;
	errors: number;
	lastError?: string;
	finding?: string;
	editedFiles: string[];
	remainingFiles: number;
	totalFiles: number;
	/** Shell commands can mutate files without returning attributable paths. */
	shellCalls: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.flatMap((item: unknown) => {
				const record = object(item);
				return record ? [record] : [];
			})
		: [];
}

export function excerpt(value: string, limit: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= limit) return text;
	const head = Math.floor((limit - 3) * 0.7);
	return text.slice(0, head) + " … " + text.slice(-(limit - 3 - head));
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return records(content)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** Only this child's successful, structured tool results count as edits.
 * No shared git diff, guessed shell commands, nested state blobs or thinking.
 * Live events start with this process, not with a resumed session's old history.
 */
export class MonitoringProgressTracker {
	private readonly pending = new Map<string, { name: string; path?: string }>();
	private readonly changed = new Set<string>();
	private readonly total = new Set<string>();
	private readonly nestedResults = new Set<string>();
	private readonly completions = new Set<string>();
	private tools = 0;
	private errors = 0;
	private shellCalls = 0;
	private lastError: string | undefined;
	private finding: string | undefined;

	constructor(private readonly cwd: string) {}

	private file(value: unknown): string | undefined {
		if (typeof value !== "string" || !value.trim()) return undefined;
		const absolute = resolve(this.cwd, value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value);
		const local = relative(this.cwd, absolute);
		return local === ".." || local.startsWith(".." + sep) || isAbsolute(local) ? absolute : local || ".";
	}

	private recordWrite(name: unknown, path: unknown): void {
		if (name !== "edit" && name !== "write") return;
		const file = this.file(path);
		if (!file) return;
		this.changed.add(file);
		this.total.add(file);
	}

	private rememberCall(id: unknown, name: unknown, args: unknown): void {
		if (typeof id !== "string" || typeof name !== "string") return;
		// The finalized assistant message and tool execution start can both
		// announce a call. Only the finalized toolResult records its outcome.
		const path = object(args)?.path;
		this.pending.set(id, { name, ...(typeof path === "string" ? { path } : {}) });
		if (this.pending.size > 256) {
			const oldest = this.pending.keys().next().value;
			if (oldest !== undefined) this.pending.delete(oldest);
		}
	}

	/** Completion entries finish an earlier call. They are not another tool invocation. */
	private completed(entry: Record<string, unknown>): void {
		const id = entry.toolCallId;
		const result = object(entry.result);
		if (typeof id !== "string" || !result || entry.toolName !== "code" || this.completions.has(id)) return;
		this.remember(this.completions, id);
		if (object(result.details)?.status === "error") {
			this.errors++;
			this.lastError = excerpt(contentText(result.content), 220) || "code failed";
		}
		this.recordNested(result.nestedCalls);
	}

	private remember(seen: Set<string>, id: string): void {
		seen.add(id);
		if (seen.size > 1024) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
	}

	private recordNested(value: unknown): void {
		for (const nested of records(object(value)?.calls)) {
			if (nested.status !== "ok" && nested.status !== "error" && nested.status !== "failed") continue;
			if (typeof nested.id === "string") {
				if (this.nestedResults.has(nested.id)) continue;
				this.remember(this.nestedResults, nested.id);
			}
			if (nested.name === "bash") this.shellCalls++;
			if (nested.status === "ok") this.recordWrite(nested.name, object(nested.arguments)?.path);
			else {
				this.errors++;
				this.lastError ??= `nested ${typeof nested.name === "string" ? nested.name : "tool"} failed`;
			}
		}
	}

	handle(event: RpcEvent): void {
		if (event.type === "entry_appended") {
			const entry = object(event.entry);
			if (entry?.type === "tool_completion") this.completed(entry);
			return;
		}
		if (event.type === "tool_execution_start") {
			this.rememberCall(event.toolCallId, event.toolName, event.args);
			return;
		}
		if (event.type !== "message_end") return;
		const message = object(event.message);
		if (!message) return;
		if (message.role === "assistant") {
			const text = contentText(message.content).trim();
			if (text) this.finding = excerpt(text, 200);
			for (const part of records(message.content)) {
				if (part.type === "toolCall") this.rememberCall(part.id, part.name, part.arguments);
			}
			return;
		}
		if (message.role !== "toolResult" || typeof message.toolName !== "string") return;
		const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		const call = id ? this.pending.get(id) : undefined;
		if (id) this.pending.delete(id);
		this.tools++;
		if (message.toolName === "bash") this.shellCalls++;
		if (message.isError === true || (message.toolName === "code" && object(message.details)?.status === "error")) {
			this.errors++;
			this.lastError = excerpt(contentText(message.content), 220) || message.toolName;
		} else if (call?.name === message.toolName) {
			this.recordWrite(call.name, call.path);
		}
		// code's typed nestedCalls envelope records individual outcomes. A
		// failed outer code call may still have successfully edited a file.
		if (message.toolName === "code") this.recordNested(message.nestedCalls);
	}

	snapshot(consume = true): MonitoringProgress {
		const files = [...this.changed];
		const result: MonitoringProgress = {
			tools: this.tools,
			errors: this.errors,
			...(this.lastError ? { lastError: this.lastError } : {}),
			...(this.finding ? { finding: this.finding } : {}),
			editedFiles: files.slice(0, MAX_FILES_SHOWN),
			remainingFiles: Math.max(0, files.length - MAX_FILES_SHOWN),
			totalFiles: this.total.size,
			shellCalls: this.shellCalls,
		};
		if (consume) {
			this.changed.clear();
			this.tools = 0;
			this.errors = 0;
			this.shellCalls = 0;
			this.lastError = undefined;
			this.finding = undefined;
		}
		return result;
	}
}

export function formatEditedFiles(progress: MonitoringProgress | undefined): string {
	if (!progress) return "Edited files: tracking unavailable.";
	const paths = progress.editedFiles.map((file) => excerpt(file, MAX_PATH_CHARS));
	const suffix = progress.remainingFiles ? ` (+${progress.remainingFiles} more)` : "";
	return (
		`Edited files since last check: ${paths.length ? paths.join(", ") + suffix : "none recorded"}; ${progress.totalFiles} tracked total.` +
		(progress.shellCalls ? " Shell writes may be untracked." : "")
	);
}

export function formatMonitoringProgress(progress: MonitoringProgress | undefined, includeFinding = true): string {
	if (!progress) return "Progress tracking unavailable.";
	return [
		`Since last check: ${progress.tools} tool results, ${progress.errors} errors.`,
		formatEditedFiles(progress),
		...(progress.lastError ? [`Latest error: ${progress.lastError}`] : []),
		...(includeFinding && progress.finding ? [`Latest assistant update: ${progress.finding}`] : []),
	].join("\n");
}
