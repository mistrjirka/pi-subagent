/** Pi model-facing tool argument schemas are the single source of static types. */
import { type Static, Type } from "typebox";

const SpawnAgentField = Type.String({
	description:
		'Exact name of a configured agent profile: a bundled profile (explore, implementer, debugging-duck by default, plus extended profiles when builtinAgents is "all") or a custom profile from ~/.pi/agent/agents or .pi/agents.',
});
const SpawnPromptField = Type.String({
	description: "The delegated task. Role instructions come from the agent profile and do not need to be repeated here.",
});
const SpawnLabelField = Type.Optional(
	Type.String({ description: "Optional short UI label. Defaults to the agent profile name." }),
);

/**
 * The model-facing spawn API intentionally has no model/thinking/tools/timeout
 * parameters. Those belong to settings/profile configuration; execution has no
 * framework-imposed task cap. Nested delegation is controlled by each profile's
 * allowed_subagents list.
 */
export function canDelegate(hasParent: boolean, allowedSubagents: readonly string[]): boolean {
	return !hasParent || allowedSubagents.length > 0;
}

export function shouldRunInBackground(hasParent: boolean, requested: boolean | undefined): boolean {
	return hasParent ? false : requested !== false;
}

const SpawnBaseFields = {
	agent: SpawnAgentField,
	prompt: SpawnPromptField,
	label: SpawnLabelField,
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"If true, keep the child resident after it completes so the same context can be resumed with agent_send.",
		}),
	),
};
const SpawnRootFields = {
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Root-only execution choice. Omitted/true returns immediately in background; false waits in foreground. Nested agents are always foreground.",
		}),
	),
	resume_id: Type.Optional(
		Type.String({
			description:
				"Recovery id from agent_recover for the same project, Git branch, and role. Loads the saved child transcript and sends this prompt as a NEW turn; it never replays work automatically.",
		}),
	),
};
const RootSpawnParamsSchema = Type.Object({ ...SpawnBaseFields, ...SpawnRootFields });
const ChildSpawnParamsSchema = Type.Object(SpawnBaseFields);

export function buildSpawnParamsSchema(hasParent: boolean) {
	return hasParent ? ChildSpawnParamsSchema : RootSpawnParamsSchema;
}

export const WaitParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The direct child id to wait for (e.g. "@max").' }),
	timeout_seconds: Type.Optional(
		Type.Number({
			minimum: 0,
			description:
				"Optional wait-window timeout in seconds. Expiry returns a live status snapshot and never stops the child. Omit for the default 180-second supervision window; 0 returns an immediate snapshot.",
		}),
	),
});

export const InspectParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The direct child id to inspect (e.g. "@max").' }),
	max_messages: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 30,
			description:
				"Maximum number of unread child conversation messages to return in this page. Defaults to 12; later unread messages remain for the next read.",
		}),
	),
});

export const StopParamsSchema = Type.Object({
	agent_id: Type.String({ description: 'The agent id to stop (e.g. "@max").' }),
});

export const SendParamsSchema = Type.Object({
	to: Type.String({
		description:
			'The agent id from agent_spawn (e.g. "@max" — a spawn result or completion ' +
			'notification carries it), or "@parent" to message the session that spawned you.',
	}),
	message: Type.String({ description: "The message text." }),
	kind: Type.Optional(
		Type.Union(
			[Type.Literal("instruction"), Type.Literal("diagnostic"), Type.Literal("urgent"), Type.Literal("answer")],
			{
				description:
					"Set answer only to explicitly resolve a waiting ask_parent question. Diagnostic and urgent are for other instructions. Default instruction.",
			},
		),
	),
	evidence: Type.Optional(
		Type.String({ description: "For kind=diagnostic, concrete fresh evidence: file, finding, and validation source." }),
	),
});

export const AskParentParamsSchema = Type.Object({
	question: Type.String({
		description: "The specific material question that blocks safe progress.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Brief evidence/context explaining why the answer cannot safely be inferred.",
		}),
	),
});

/** Tool argument types come from the same schemas registered with Pi. */
export type SpawnParams = Static<typeof RootSpawnParamsSchema>;
export type WaitParams = Static<typeof WaitParamsSchema>;
export type InspectParams = Static<typeof InspectParamsSchema>;
export type StopParams = Static<typeof StopParamsSchema>;
export type SendParams = Static<typeof SendParamsSchema>;
export type AskParentParams = Static<typeof AskParentParamsSchema>;
