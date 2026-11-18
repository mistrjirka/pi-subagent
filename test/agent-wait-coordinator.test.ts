import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentWaitCoordinator } from "../agent-wait-coordinator.js";
import type { AgentMessage } from "../protocol.js";
import type { AgentSettlement } from "../registry-contracts.js";

const complete: AgentSettlement = {
	completion: { status: "completed", output: "done", stats: { tokens: 1, toolUses: 1, durationMs: 1 } },
};

function setup() {
	const paused: string[] = [];
	const resumed: string[] = [];
	const waits = new AgentWaitCoordinator({
		pause(id) {
			paused.push(id);
		},
		resume(id) {
			resumed.push(id);
		},
	});
	return { waits, paused, resumed };
}
const message = (): AgentMessage => ({ from: "rona", to: "@parent", message: "Progress", sentAt: 100 });

describe("AgentWaitCoordinator", () => {
	it("delivers a completion to one waiter and wakes parallel waiters without repeating it", async () => {
		const { waits, paused, resumed } = setup();
		const one = waits.wait("rona");
		const two = waits.wait("rona");
		assert.equal(waits.settle("rona", complete), true);
		assert.deepEqual(await one, complete);
		assert.deepEqual(await two, { kind: "other_wait", reason: "completion" });
		assert.equal(waits.settle("rona", complete), false);
		assert.deepEqual(paused, ["rona", "rona"]);
		assert.deepEqual(resumed, ["rona", "rona"]);
	});

	it("wakes explicit waits on another child's progress without settling their targets", async () => {
		const { waits, resumed } = setup();
		const left = waits.wait("aria", undefined, 1_000, true);
		const right = waits.wait("max", undefined, 1_000, true);
		assert.equal(waits.wakeForMessage(message()), true);
		assert.deepEqual(await left, { kind: "message", message: message() });
		assert.deepEqual(await right, { kind: "other_wait", reason: "message" });
		assert.deepEqual(resumed, ["aria", "max"]);
		assert.equal(waits.wakeForMessage(message()), false);
	});

	it("keeps ordinary waits independent of parent progress", async () => {
		const { waits } = setup();
		const wait = waits.wait("aria");
		assert.equal(waits.wakeForMessage(message()), false);
		assert.equal(waits.settle("aria", complete), true);
		assert.deepEqual(await wait, complete);
	});

	it("releases supervision and listeners on abort, zero timeout and expiry", async () => {
		const { waits, paused, resumed } = setup();
		const ctrl = new AbortController();
		const aborted = waits.wait("aria", ctrl.signal, 300, true);
		ctrl.abort();
		await assert.rejects(aborted, /agent_wait cancelled/);
		const immediate = await waits.wait("max", undefined, 0, true);
		assert.equal(immediate, null);
		const timed = await waits.wait("kim", undefined, 5, true);
		assert.equal(timed, null);
		assert.deepEqual(paused, ["aria", "max", "kim"]);
		assert.deepEqual(resumed, ["aria", "max", "kim"]);
		assert.equal(waits.wakeForMessage(message()), false);
		await assert.rejects(waits.wait("aria", new AbortController().signal, -1), /finite non-negative/);
	});

	it("unblocks all waits during shutdown, including those with no timeout", async () => {
		const { waits, resumed } = setup();
		const left = waits.wait("aria");
		const right = waits.wait("max", undefined, undefined, true);
		waits.shutdown();
		assert.equal(await left, undefined);
		assert.equal(await right, undefined);
		assert.deepEqual(resumed, ["aria", "max"]);
		assert.equal(waits.settle("aria", complete), false);
		assert.equal(waits.wakeForMessage(message()), false);
		waits.shutdown();
	});
});
