export function reportedAgentState(agent: {
	status?: "queued" | "running" | "completed" | "failed" | "stopped";
	awaitingParent?: boolean;
	persistent?: boolean;
	shouldStayResident?: boolean;
}): "queued" | "running" | "waiting" | "idle" | "completed" | "failed" | "stopped" {
	if (agent.status === "stopped" || agent.status === "failed") return agent.status;
	if (agent.awaitingParent) return "waiting";
	if (agent.status === "completed" && (agent.shouldStayResident ?? agent.persistent)) return "idle";
	return agent.status ?? "queued";
}
