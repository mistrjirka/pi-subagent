/** Build a bounded reminder from fresh child activity without waking stale tasks. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportedAgentState } from "./agent-state.js";
import type { AgentActivity } from "./event-interpret.js";
import type { RegisteredAgent } from "./registry.js";

export function activitySummary(activity: AgentActivity | undefined): string {
	if (!activity) return "no recent activity reported";
	if (activity.kind === "thinking") return "thinking";
	if (activity.kind === "tool") {
		const args = activity.args.replace(/\s+/g, " ").trim();
		const excerpt = Array.from(args).slice(0, 180).join("");
		return `${activity.name}${excerpt ? ` — ${excerpt}${Array.from(args).length > 180 ? "…" : ""}` : ""}`;
	}
	const text = activity.text.replace(/\s+/g, " ").trim();
	return text ? `writing — ${Array.from(text).slice(-180).join("")}` : "writing";
}

export const createSupervisionReminder =
	(pi: Pick<ExtensionAPI, "sendMessage">, lookup: (id: string) => RegisteredAgent | undefined) =>
	async (agent: RegisteredAgent, unsupervisedMs: number): Promise<void> => {
		const minutes = Math.max(1, Math.round(unsupervisedMs / 60_000));
		const activity = activitySummary(agent.getLatestActivity?.());
		const progress = agent.getMonitoringProgress?.(false);
		const current = lookup(agent.agentId);
		if (current !== agent || (current.status && current.status !== "running" && current.status !== "queued")) {
			return;
		}
		pi.sendMessage(
			{
				customType: "subagent-supervision",
				content:
					`Subagent @${agent.agentId} unsupervised for about ${minutes} minute${minutes === 1 ? "" : "s"}. Latest activity: ${activity}.\n` +
					(progress?.errors
						? `New tool errors: ${progress.errors}. Latest: ${progress.lastError ?? "unknown"}\n`
						: "") +
					"Check whether it is making real progress; resume agent_wait (normally a 150-second window) or inspect a concrete concern.",
				display: true,
				details: {
					agentId: agent.agentId,
					label: agent.label,
					state: reportedAgentState(agent),
					activity: agent.getLatestActivity?.(),
					progress,
					unsupervisedMs,
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};
