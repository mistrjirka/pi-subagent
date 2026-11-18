import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentBackgroundSpawn, presentFinishedSpawn, type SpawnPresentationContext } from "../spawn-result.js";
import type { SpawnOutcome } from "../spawn-session.js";

const context = (): SpawnPresentationContext => ({
	agent: {
		agentId: "max",
		label: "Backend checks",
		status: "completed",
		model: "test/model",
		thinking: "medium",
	},
	profile: "implementer",
	task: "check backend",
	treeId: "tree-one",
	parentAgentId: "root",
	controlDir: "/tmp/test",
	statusPath: "/tmp/test/status.json",
	startedAt: 1_000,
	nested: { total: 0, running: 0, idle: 0, done: 0, failed: 0, stopped: 0 },
});
const finished = (
	overrides: Partial<Extract<SpawnOutcome, { kind: "finished" }>> = {},
): Extract<SpawnOutcome, { kind: "finished" }> => ({
	kind: "finished",
	status: "completed",
	output: "done",
	stoppedByControl: false,
	resident: false,
	events: [],
	sessionPath: "/tmp/session",
	sessionId: "session-id",
	startedAt: 1_000,
	endedAt: 2_000,
	...overrides,
});

describe("typed spawn result presenter", () => {
	it("formats background spawn and preserves identity for the status and card", () => {
		const ctx = { ...context(), resumeSessionPath: "/tmp/resume", recoveryId: "id-1" };
		const result = presentBackgroundSpawn(ctx);
		assert.match(result.result.content[0]!.text, /^Resumed background agent @max/);
		assert.match(result.result.content[0]!.text, /Recovery id: id-1/);
		assert.equal(result.result.details.statusPath, ctx.statusPath);
		assert.equal(result.progress?.details.statusPath, ctx.statusPath);
		assert.equal(result.progress?.details.runInBackground, true);
		assert.equal(result.treeRemoval, undefined);
	});

	it("formats successful nonresident and resident completion", () => {
		const normal = presentFinishedSpawn(finished(), context(), true);
		assert.equal(normal.result.content[0]!.text, "done");
		assert.equal(normal.treeRemoval, "done");
		assert.equal(normal.result.details.sessionId, "session-id");

		const resident = presentFinishedSpawn(finished({ resident: true }), context(), true);
		assert.match(resident.result.content[0]!.text, /resident/);
		assert.equal(resident.treeRemoval, undefined);
	});

	it("keeps the failed or stopped result an error without inventing success", () => {
		const failure = presentFinishedSpawn(finished({ status: "failed", output: "" }), context(), true);
		assert.equal(failure.result.isError, true);
		assert.equal(failure.result.details.error, "Sub-agent failed.");
		assert.equal(failure.treeRemoval, "failed");

		const stopped = presentFinishedSpawn(
			finished({ status: "stopped", output: "", stoppedByControl: false }),
			context(),
			false,
		);
		assert.match(stopped.result.content[0]!.text, /partial/);
		assert.equal(stopped.result.isError, true);
		assert.equal(stopped.treeRemoval, undefined);
	});

	it("preserves ask_parent without removing a waiting child", () => {
		const ctx = context();
		ctx.agent.awaitingParent = true;
		ctx.pendingQuestion = { from: "max", question: "Choose a path", context: "Two legal options" };
		const result = presentFinishedSpawn(finished({ resident: true }), ctx, true);
		assert.match(result.result.content[0]!.text, /waiting for your answer/);
		assert.equal(result.result.details.waitingForParent, true);
		assert.equal(result.result.details.question, "Choose a path");
		assert.equal(result.treeRemoval, undefined);
	});
});
