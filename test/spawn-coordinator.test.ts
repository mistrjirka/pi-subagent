import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RecoveryPort } from "../spawn-coordinator.js";
import { SpawnCoordinator, type SpawnCoordinatorServices } from "../spawn-coordinator.js";
import type { SpawnParams } from "../tool-params.js";

const agent = {
	name: "explore",
	prompt: "Explore",
	allowedSubagents: [],
	sourcePath: "/fixture/explore.md",
};
const services: SpawnCoordinatorServices = {
	discoverProfiles: () => ({ profiles: new Map([["explore", agent]]), warnings: [] }),
	resolveProfile: (profile) => ({ ...profile }),
	resolveModel: () => ({ model: "test/working" }),
};
const ctx = { cwd: "/fixture", modelRegistry: {} as ModelRegistry, model: undefined };

function coordinator(hasParent = false, recovery?: RecoveryPort) {
	return new SpawnCoordinator(
		{
			hasParent,
			allowedSubagents: hasParent ? ["explore"] : [],
			currentAgentProfile: "implementer",
			parentAgentId: "root",
			...(recovery ? { recovery } : {}),
		},
		services,
	);
}

describe("schema-derived spawn policy", () => {
	it("derives a typed plan for a root/background call", () => {
		const params = { agent: "explore", prompt: " inspect source " } satisfies SpawnParams;
		const result = coordinator().prepare(params, ctx);
		assert.equal(result.kind, "ready");
		if (result.kind !== "ready") return;
		assert.equal(result.task, "inspect source");
		assert.equal(result.runInBackground, true);
		assert.equal(result.resolved.model, "test/working");
	});

	it("enforces foreground-only nested execution", () => {
		const result = coordinator(true).prepare({ agent: "explore", prompt: "search" }, ctx);
		assert.equal(result.kind, "ready");
		if (result.kind === "ready") assert.equal(result.runInBackground, false);
		const forbidden = coordinator(true).prepare(
			{
				agent: "explore",
				prompt: "search",
				run_in_background: true,
			},
			ctx,
		);
		assert.equal(forbidden.kind, "rejected");
		if (forbidden.kind === "rejected") assert.equal(forbidden.error, "background spawns are root-only");
	});

	it("rejects unknown profiles and empty prompts before launching a process", () => {
		const unknown = coordinator().prepare({ agent: "missing", prompt: "task" }, ctx);
		assert.equal(unknown.kind, "rejected");
		const blank = coordinator().prepare({ agent: "explore", prompt: "   " }, ctx);
		assert.equal(blank.kind, "rejected");
		if (blank.kind === "rejected") assert.equal(blank.error, "`prompt` is required.");
	});

	it("keeps recoverability as an explicit root-owned claim", () => {
		const denied = coordinator().prepare(
			{
				agent: "explore",
				prompt: "continue",
				resume_id: "saved",
			},
			ctx,
		);
		assert.equal(denied.kind, "rejected");
		const fakeRecovery = {
			resume: () => ({ id: "saved", sessionPath: "/fixture/saved.jsonl" }),
		} satisfies RecoveryPort;
		const accepted = coordinator(false, fakeRecovery).prepare(
			{
				agent: "explore",
				prompt: "continue",
				resume_id: "saved",
			},
			ctx,
		);
		assert.equal(accepted.kind, "ready");
		if (accepted.kind === "ready") {
			assert.equal(accepted.recoveryId, "saved");
			assert.equal(accepted.resumeSessionPath, "/fixture/saved.jsonl");
		}
	});
});
