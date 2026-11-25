/** Read-only registry discovery and persistent context recovery. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RecoveryStore } from "./recovery.js";
import type { AgentRegistry } from "./registry.js";

const DiscoveryParamsSchema = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

type ToolError = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError: true;
};

export type DiscoveryToolsPorts = {
	registry: Pick<AgentRegistry, "describeMessageTargets">;
	recovery?: RecoveryStore | undefined;
	toErrorResult: (error: unknown) => ToolError;
};

export function registerDiscoveryTools(pi: ExtensionAPI, ports: DiscoveryToolsPorts): void {
	// Context compaction replaces the parent's textual history, not the live
	// in-process children. Expose their current names without reading transcripts
	// so a compacted parent can rediscover them instead of spawning duplicates.
	pi.registerTool({
		name: "agent_list",
		label: "List Direct Agents",
		description:
			"Read-only list of running, waiting, resident/idle and recently finished direct child agents in this Pi process. Use after compaction or when an agent id is uncertain. " +
			(ports.recovery
				? "After a Pi restart use agent_recover for saved persistent sessions instead."
				: "Only current-process children are available.") +
			"",
		promptSnippet: "Rediscover current direct child agents and their states after context compaction",
		parameters: DiscoveryParamsSchema,
		async execute(_callId, raw) {
			const requested = raw.limit;
			const limit =
				typeof requested === "number" && Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 20;
			return {
				content: [{ type: "text", text: ports.registry.describeMessageTargets("", limit) }],
				details: { limit },
			};
		},
	});

	const recovery = ports.recovery;
	if (recovery) {
		pi.registerTool({
			name: "agent_recover",
			label: "Recover Agent Context",
			description:
				"List previous persistent subagent transcripts that can be resumed in the current project and Git branch. Read-only; never starts a child. To continue one, pass its recovery id to agent_spawn.resume_id with a fresh scoped prompt.",
			promptSnippet: "Find recoverable persistent child contexts after a Pi restart",
			promptGuidelines: [
				"Check recoverable agents after a Pi restart unless a fresh context was explicitly requested. Omit resume_id to start fresh.",
				"Reuse only when the role, project, Git branch, and task acceptance boundary still match. An old transcript is context, not proof that its changes still exist.",
				"Do not resume a worker already active in another Pi process. Supply the fresh goal, changed requirements and current code state as the new spawn prompt.",
			],
			parameters: DiscoveryParamsSchema,
			async execute(_callId, raw, _signal, _onUpdate, ctx) {
				try {
					const matches = recovery.list(ctx.cwd, raw.limit ?? 20);
					const text = matches.length
						? matches
								.map(
									({ record, available }) =>
										`${record.id} — ${record.profile} (${record.label}), ${available ? "recoverable" : "active elsewhere"}, ${record.updatedAt}, model ${record.model}`,
								)
								.join("\n")
						: "No recorded persistent agent contexts for this project and Git branch.";
					return {
						content: [
							{
								type: "text",
								text:
									text +
									"\nTo resume: agent_spawn({agent: <role>, resume_id: <id>, persistent: true, prompt: <fresh instructions>}).",
							},
						],
						details: { count: matches.length },
					};
				} catch (error) {
					return ports.toErrorResult(error);
				}
			},
		});
	}
}
