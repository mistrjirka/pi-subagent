import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegisteredAgent } from "../registry.js";
import { SupervisionService } from "../supervision.js";

function agent(): RegisteredAgent {
	return {
		agentId: "aria",
		label: "Background worker",
		status: "running",
		stoppedByControl: false,
		markStopped() {},
		async stop() {},
	};
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("SupervisionService owns per-child reminder timers", () => {
	it("runs only while parent is idle and pauses during explicit waits", async () => {
		const target = agent();
		const reminders: number[] = [];
		const service = new SupervisionService({
			lookup: (id) => (id === "aria" ? target : undefined),
			remind: (_agent, duration) => {
				reminders.push(duration);
			},
			intervalMs: 12,
		});
		try {
			service.start("aria");
			await delay(28);
			assert.deepEqual(reminders, [], "parent active suppresses reminders");
			service.parentBecameIdle();
			await delay(34);
			assert.ok(reminders.length >= 1, "idle parent receives reminder");
			service.pause("aria");
			const before = reminders.length;
			await delay(32);
			assert.equal(reminders.length, before, "agent_wait pauses reminders");
			service.resume("aria");
			await delay(34);
			assert.ok(reminders.length > before, "reminders resume after wait");
			service.parentBecameActive();
			const paused = reminders.length;
			await delay(34);
			assert.equal(reminders.length, paused, "new model turn cancels reminders");
		} finally {
			service.stop("aria");
		}
	});

	it("never starts a reminder for unknown or already completed agents", async () => {
		const target = agent();
		let reminders = 0;
		const service = new SupervisionService({
			lookup: (id) => (id === "aria" ? target : undefined),
			remind: () => {
				reminders++;
			},
			intervalMs: 10,
		});
		service.start("unknown");
		target.status = "completed";
		service.start("aria");
		service.parentBecameIdle();
		await delay(30);
		assert.equal(reminders, 0);
		service.stop("aria");
	});
});
