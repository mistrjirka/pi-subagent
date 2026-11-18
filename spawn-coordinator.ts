import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ResolvedModel, resolveModel } from "./model.js";
import {
	type AgentProfile,
	discoverAgentProfiles,
	formatAvailableProfiles,
	type ResolvedAgentProfile,
	resolveAgentProfile,
} from "./profiles.js";
/** Narrow dependency: preparation only claims a saved session. */
export type RecoveryPort = {
	resume(id: string, cwd: string, profile: string, model: string): { id: string; sessionPath: string };
};

import { type SpawnParams, shouldRunInBackground } from "./tool-params.js";

export type SpawnPlan = {
	kind: "ready";
	profile: AgentProfile;
	runtimeProfile: ResolvedAgentProfile;
	label: string;
	task: string;
	runInBackground: boolean;
	resolved: ResolvedModel;
	recoveryId?: string;
	resumeSessionPath?: string;
};
export type SpawnRejected = {
	kind: "rejected";
	message: string;
	error: string;
	label?: string;
	runInBackground?: boolean;
};
export type SpawnDecision = SpawnPlan | SpawnRejected;

type SpawnContext = {
	cwd: string;
	modelRegistry: ModelRegistry;
	model: Parameters<typeof resolveModel>[1];
};

export type SpawnCoordinatorServices = {
	discoverProfiles: typeof discoverAgentProfiles;
	resolveProfile: typeof resolveAgentProfile;
	resolveModel: typeof resolveModel;
};
const defaultServices: SpawnCoordinatorServices = {
	discoverProfiles: discoverAgentProfiles,
	resolveProfile: resolveAgentProfile,
	resolveModel,
};

/** Owns spawn policy and the exclusive recovery claim, not UI or process creation. */
export class SpawnCoordinator {
	constructor(
		private readonly options: {
			hasParent: boolean;
			allowedSubagents: readonly string[];
			currentAgentProfile: string;
			parentAgentId: string;
			recovery?: RecoveryPort;
		},
		private readonly services: SpawnCoordinatorServices = defaultServices,
	) {}

	prepare(params: SpawnParams, ctx: SpawnContext): SpawnDecision {
		const reject = (message: string, error = message, extra: Partial<SpawnRejected> = {}): SpawnRejected => ({
			kind: "rejected",
			message,
			error,
			...extra,
		});
		const requestedAgent = params.agent?.trim();
		if (!requestedAgent) return reject("`agent` is required.");
		const catalog = this.services.discoverProfiles(ctx.cwd);
		const profile = catalog.profiles.get(requestedAgent);
		if (!profile)
			return reject(
				`Unknown agent profile ${JSON.stringify(requestedAgent)}. Available: ${formatAvailableProfiles(catalog)}`,
			);
		if (this.options.hasParent && !this.options.allowedSubagents.includes(profile.name)) {
			const allowed = this.options.allowedSubagents.length ? this.options.allowedSubagents.join(", ") : "none";
			return reject(
				`Agent ${JSON.stringify(this.options.currentAgentProfile || this.options.parentAgentId)} cannot spawn ${JSON.stringify(profile.name)}. Allowed subagents: ${allowed}.`,
			);
		}
		const runtimeProfile = this.services.resolveProfile(profile, ctx.cwd);
		const label = params.label?.trim() || profile.name;
		if (this.options.hasParent && params.run_in_background != null) {
			return reject(
				"run_in_background is root-only: your lifetime ends when this call returns, so " +
					"background work could not outlive you nor deliver its result. For parallel " +
					"work, issue several foreground agent_spawn calls together (they run " +
					"concurrently); for long-running work, describe it in your reply so the " +
					"caller can decide.",
				"background spawns are root-only",
				{ label },
			);
		}
		const runInBackground = shouldRunInBackground(this.options.hasParent, params.run_in_background);
		const task = params.prompt?.trim();
		if (!task) return reject("`prompt` is required.");
		const resolved = this.services.resolveModel(ctx.modelRegistry, ctx.model, runtimeProfile.resolvedModel);
		if (resolved.error) {
			return reject(resolved.error, resolved.error, runInBackground ? { runInBackground: true, label } : {});
		}
		let recoveryId: string | undefined;
		let resumeSessionPath: string | undefined;
		if (params.resume_id) {
			if (!this.options.recovery) return reject("Only a root session can recover a persistent child.");
			try {
				const record = this.options.recovery.resume(
					params.resume_id,
					ctx.cwd,
					profile.name,
					resolved.model ?? "inherited",
				);
				recoveryId = record.id;
				resumeSessionPath = record.sessionPath;
			} catch (error) {
				return reject(error instanceof Error ? error.message : String(error));
			}
		}
		return {
			kind: "ready",
			profile,
			runtimeProfile,
			label,
			task,
			runInBackground,
			resolved,
			...(recoveryId ? { recoveryId } : {}),
			...(resumeSessionPath ? { resumeSessionPath } : {}),
		};
	}
}
