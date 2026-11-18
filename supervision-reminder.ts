/** Build a bounded reminder from fresh child activity without waking stale tasks. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportedAgentState } from "./agent-state.js";
import type { AgentActivity } from "./event-interpret.js";
import type { RegisteredAgent } from "./registry.js";
import { getMonitoringTranscript } from "./transcript.js";

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
		const transcript = await getMonitoringTranscript(agent, {
			maxMessages: 4,
			maxChars: 4_000,
			perMessageChars: 1_000,
		});
		// Transcript collection is asynchronous. The child may settle while
		// it is in flight; do not emit a stale "still running" reminder.
		const current = lookup(agent.agentId);
		if (current !== agent || (current.status && current.status !== "running" && current.status !== "queued")) {
			return;
		}
		pi.sendMessage(
			{
				customType: "subagent-supervision",
				content:
					`Subagent @${agent.agentId} has been running unsupervised for about ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
					`Latest activity: ${activity}. ` +
					"SUPERVISION CHECK REQUIRED: compare new evidence with the assigned scope and last correction. Is the child making real progress? " +
					"If progress remains aligned, continue with agent_wait (normally a 150-second window) without reassurance messages, document updates, or repeated audits. " +
					"Inspect or steer with agent_send for a concrete blocker, scope drift, repeated failure, or necessary coordination. Stop the child when needed. " +
					"A timeout or long-running command alone is not a stall. Use agent_wait for subagents rather than shell polling. Ordinary external processes may use process/job waits." +
					`\n\nRecent transcript (${transcript.source}):\n${transcript.text}`,
				display: true,
				details: {
					agentId: agent.agentId,
					label: agent.label,
					state: reportedAgentState(agent),
					activity: agent.getLatestActivity?.(),
					transcript: transcript.text,
					transcriptSource: transcript.source,
					unsupervisedMs,
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};
