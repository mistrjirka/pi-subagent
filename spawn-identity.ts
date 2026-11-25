/** The exact identity inherited by each resident Pi RPC child. */
import type { AgentProfile } from "./profiles.js";
import { buildAncestorChain } from "./registry.js";

export interface SpawnIdentityEnvironment extends Record<string, string> {
	PI_SUBAGENT_AGENT_ID: string;
	PI_SUBAGENT_PROFILE: string;
	PI_SUBAGENT_ALLOWED_SUBAGENTS: string;
	PI_SUBAGENT_TREE_ID: string;
	PI_SUBAGENT_ANCESTOR_IDS: string;
}

export function childIdentityEnvironment(
	agentId: string,
	profile: Pick<AgentProfile, "name" | "allowedSubagents">,
	treeId: string,
	parentAgentId: string,
	ancestorIds: string | undefined,
	toolGroups?: readonly string[],
): SpawnIdentityEnvironment {
	return {
		PI_SUBAGENT_AGENT_ID: agentId,
		// Always override the inherited value: each profile selects its own tools.
		PI_SUBAGENT_TOOL_GROUPS: toolGroups === undefined ? "" : JSON.stringify(toolGroups),
		PI_SUBAGENT_PROFILE: profile.name,
		PI_SUBAGENT_ALLOWED_SUBAGENTS: JSON.stringify(profile.allowedSubagents),
		PI_SUBAGENT_TREE_ID: treeId,
		PI_SUBAGENT_ANCESTOR_IDS: buildAncestorChain(agentId, parentAgentId, ancestorIds),
	};
}
