/** Nested child events traverse the same tree as agent_send. */
import { type AgentActivity, type AgentTreeEvent, TREE_STATUS_KEY } from "./event-interpret.js";

/**
 * Tree telemetry (nested agents): a sub-agent's own spawns are invisible to
 * the user — the only TUI is the root session's. Every node reports ALL its
 * spawns upward (foreground and background alike) over the same setStatus
 * transport as @parent messages; intermediate nodes forward verbatim
 * (depth + 1). Consumption is decided at the anchor boundary — the execute
 * that owns the visible surface:
 *   • root + background child → widget rows (indent = depth)
 *   • root + foreground child → folded into that card's nested meta counters
 * A foreground card's subtree therefore never reaches the widget, and a
 * background row's subtree never leaks into a card — one subtree, one
 * surface (SPEC: 显示面统一规则).
 */
export interface TreeTelemetry {
	report(event: AgentTreeEvent): void;
	add(agent: { agentId: string; label: string; startedAt: number }, status: "running" | "idle"): void;
	activity(agent: { agentId: string; getLatestActivity(): AgentActivity | undefined }): void;
	remove(agentId: string, status: "done" | "failed" | "stopped"): void;
}

export function createTreeTelemetry(
	hasParent: boolean,
	ownAgentId: string,
	status: (key: string, value: string) => void,
): TreeTelemetry {
	/** Ids reported as added — guards activity/remove so unknown ids never
	 *  emit telemetry. */
	const tracked = new Set<string>();
	const report = (event: AgentTreeEvent) => status(TREE_STATUS_KEY, JSON.stringify(event));
	return {
		report,
		add(agent: { agentId: string; label: string; startedAt: number }, status: "running" | "idle"): void {
			if (!hasParent) return;
			tracked.add(agent.agentId);
			// `parent` is my own id: I am the direct parent of every child I spawn.
			// Forwarding nodes pass the event through verbatim, so the link stays
			// anchored at the real parent however deep the chain runs.
			report({
				op: "add",
				id: agent.agentId,
				label: agent.label,
				startedAt: agent.startedAt,
				depth: 1,
				status,
				parent: ownAgentId,
			});
		},
		activity(agent: { agentId: string; getLatestActivity(): AgentActivity | undefined }): void {
			if (!tracked.has(agent.agentId)) return;
			const activity = agent.getLatestActivity();
			if (!activity) return;
			report({ op: "activity", id: agent.agentId, activity });
		},
		remove(agentId: string, status: "done" | "failed" | "stopped"): void {
			if (!tracked.delete(agentId)) return;
			report({ op: "remove", id: agentId, status });
		},
	};
}
