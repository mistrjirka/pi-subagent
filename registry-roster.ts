/** Pure inspection and compaction-roster projections. No registry mutation. */
import type { AgentSettlement, RegisteredAgent } from "./registry-contracts.js";

/** Snapshot used by compaction. It never reads child transcripts or changes the registry. */
export function checkpointRoster(
	agents: ReadonlyMap<string, RegisteredAgent>,
	limit = 24,
): {
	v: 1;
	total: number;
	agents: Array<{ id: string; label: string; description: string; state: "running" | "waiting" | "idle" }>;
} {
	const active = [...agents.values()].filter(
		(agent) => !agent.stoppedByControl && agent.status !== "failed" && agent.status !== "stopped",
	);
	const state = (agent: RegisteredAgent): "running" | "waiting" | "idle" =>
		agent.awaitingParent ? "waiting" : agent.status === "completed" ? "idle" : "running";
	const priority = { waiting: 0, running: 1, idle: 2 };
	active.sort((a, b) => priority[state(a)] - priority[state(b)]);
	const compact = (value: string, length: number) => value.replace(/\s+/g, " ").trim().slice(0, length);
	return {
		v: 1,
		total: active.length,
		agents: active.slice(0, Math.max(1, Math.min(24, limit))).map((agent) => ({
			id: agent.agentId,
			label: compact(agent.label, 80),
			description: compact(agent.taskSummary ?? "", 120),
			state: state(agent),
		})),
	};
}

/**
 * Compact direct-child address book for a failed agent_send.
 * Running and resident children are deliverable; exited children are
 * inspectable but cannot be resumed. Never advertise descendants.
 */
export function describeMessageTargets(
	agents: ReadonlyMap<string, RegisteredAgent>,
	settlements: ReadonlyMap<string, AgentSettlement>,
	target: string,
	limit = 8,
): string {
	const active = [...agents.values()];
	const ended = [...settlements.entries()].filter(([id]) => !agents.has(id));
	const targetSettlement = settlements.get(target);
	const targetNote =
		!agents.has(target) && targetSettlement
			? `@${target} finished (${targetSettlement.completion.status}); its process exited and cannot receive agent_send. `
			: "";
	const available = active.slice(0, limit).map((agent) => {
		const state = agent.awaitingParent
			? "waiting for answer"
			: agent.status === "completed"
				? "idle, reusable"
				: (agent.status ?? "running");
		return `@${agent.agentId} (${agent.label}, ${state})`;
	});
	const completed = ended.slice(-limit).map(([id, settlement]) => `@${id} (${settlement.completion.status}, exited)`);
	return (
		targetNote +
		`Deliverable direct children: ${available.join(", ") || "none"}${active.length > limit ? ` (+${active.length - limit} more)` : ""}. ` +
		`Finished/exited: ${completed.join(", ") || "none"}${ended.length > limit ? ` (+${ended.length - limit} more)` : ""}. ` +
		"Use agent_inspect on a finished child to read its result. To continue work after it exited, spawn a new child; only resident children accept agent_send."
	);
}
