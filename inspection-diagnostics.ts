/** Explicit persisted-context diagnostics. Never project reasoning or signatures. */
import { excerpt } from "./monitoring-progress.js";
import { SessionEntryCursor } from "./session-transcript.js";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function inspectContextDiagnostics(sessionPath: string | undefined): string {
	if (!sessionPath) return "No persisted child session is available for context diagnostics.";
	try {
		// Independent bounded reader. This does not advance either inspection cursor.
		const page = new SessionEntryCursor().read(sessionPath, 24);
		const rows = [
			"Persisted Pi context only. Provider wire inputs can differ. No reasoning or content bodies are included.",
		];
		for (const value of page.entries) {
			const entry = record(value);
			if (!entry) continue;
			const message = record(entry.message);
			if (message?.role === "system") {
				const sections = record(message.sections);
				if (sections)
					rows.push(
						`System sections (characters): ${Object.entries(sections)
							.map(([name, text]) => `${name}=${typeof text === "string" ? text.length : "?"}`)
							.join(", ")}`,
					);
				if (Array.isArray(message.toolsAdded)) {
					rows.push(`Registered tool schemas: ${message.toolsAdded.length}`);
					rows.push(
						`Tools: ${message.toolsAdded
							.map(record)
							.map((tool) => String(tool?.name ?? "unknown"))
							.join(", ")}`,
					);
				}
			} else if (entry.type === "custom_message") {
				rows.push(
					`Custom message: ${String(entry.customType ?? "unknown")}; display=${String(entry.display)}; at ${String(entry.timestamp ?? "unknown")}`,
				);
			} else if (entry.type === "message" && message) {
				const blocks = Array.isArray(message.content) ? message.content.map(record).filter(Boolean) : [];
				const toolCalls = blocks.filter((block) => block?.type === "toolCall").map((block) => block?.name);
				rows.push(
					`Message: ${String(message.role ?? "unknown")}${toolCalls.length ? `; tools=${toolCalls.join(",")}` : ""}; at ${String(entry.timestamp ?? "unknown")}`,
				);
			}
		}
		if (page.hasMore)
			rows.push("Only the first bounded context window is shown; use the session file for later metadata.");
		return rows
			.map((row) => excerpt(row, 400))
			.join("\n")
			.slice(0, 2200);
	} catch (error) {
		return `Context diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
}
