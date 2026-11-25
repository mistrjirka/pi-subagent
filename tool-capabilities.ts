/** Optional context selection, not an operating-system permission boundary. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TOOL_GROUPS = {
	discovery: ["codegraph_*", "semble_*"],
	web: ["web_search", "source_check", "fetch_content", "get_search_content"],
	browser: ["mcp__playwright*", "browser_*"],
	mcp: ["mcp", "mcp__*"],
	memory_write: ["memory_add", "memory_replace", "memory_remove"],
} as const;

const REQUIRED = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"code",
	"bash_watch",
	"bash_output",
	"bash_tasks",
	"bash_kill",
	"session_search",
	"user_artifact",
	"memory_search",
	"memory_read",
	"agent_send",
	"ask_parent",
]);
const CHILD_MANAGEMENT = new Set(["agent_list", "agent_spawn", "agent_wait", "agent_inspect", "agent_stop"]);

export function parseToolGroups(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !(Object.hasOwn(TOOL_GROUPS, item) || /^tool:[\w.-]+$/.test(item)))
	) {
		throw new Error(
			`toolGroups must contain group names (${Object.keys(TOOL_GROUPS).join(", ")}) or tool:<exact_name>`,
		);
	}
	const groups: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && !groups.includes(item)) groups.push(item);
	}
	return groups;
}

export function toolGroupsFromEnvironment(value: string | undefined): string[] | undefined {
	return !value ? undefined : parseToolGroups(JSON.parse(value));
}

export function selectChildTools(
	active: readonly string[],
	groups: readonly string[] | undefined,
	delegates: boolean,
): string[] {
	const patterns = groups?.flatMap((group) =>
		group.startsWith("tool:")
			? [group.slice(5)]
			: (Object.entries(TOOL_GROUPS).find(([name]) => name === group)?.[1] ?? []),
	);
	return active.filter((name) => {
		if (CHILD_MANAGEMENT.has(name)) return delegates;
		if (name === "agent_recover") return false;
		if (groups === undefined || REQUIRED.has(name)) return true;
		return patterns?.some((pattern) =>
			pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
		);
	});
}

/** Set Pi's active registry so schemas and tool-derived system guidance agree. */
export function registerChildToolSelection(pi: ExtensionAPI, groups: string[] | undefined, delegates: boolean): void {
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		pi.setActiveTools(selectChildTools(active, groups, delegates));
	});
}
