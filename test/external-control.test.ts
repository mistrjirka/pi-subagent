import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ExternalControlBridge, type ExternallyControllableAgent } from "../external-control.js";
import { AgentRegistry } from "../registry.js";

const bridges: ExternalControlBridge[] = [];
afterEach(() => {
	for (const bridge of bridges.splice(0)) bridge.cleanup();
});

class FakeAgent implements ExternallyControllableAgent {
	readonly agentId = "max";
	readonly label = "implementer";
	readonly startedAt = Date.now();
	readonly model = "provider/model";
	readonly thinking = "medium";
	persistent = false;
	status: "queued" | "running" | "completed" | "failed" | "stopped" = "running";
	awaitingParent = false;
	sessionPath = "/tmp/child.jsonl";
	messages: string[] = [];
	stopCalls = 0;
	async sendMessage(text: string): Promise<boolean> {
		this.messages.push(text);
		return true;
	}
	async stop(): Promise<void> {
		this.stopCalls++;
		this.status = "stopped";
	}
}

async function eventually(predicate: () => boolean, timeout = 2000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeout) throw new Error("condition did not become true");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("ExternalControlBridge", () => {
	it("writes a PiTTy-readable status snapshot", () => {
		const agent = new FakeAgent();
		const bridge = new ExternalControlBridge(agent, {
			profile: "implementer",
			parentPid: process.pid,
			treeId: "tree-1",
			parentAgentId: "root",
		});
		bridges.push(bridge);
		const status = JSON.parse(fs.readFileSync(bridge.statusPath, "utf8"));
		assert.equal(status.runtime, "profiled-subagents");
		assert.equal(status.agentId, "max");
		assert.equal(status.profile, "implementer");
		assert.equal(status.treeId, "tree-1");
		assert.equal(status.parentAgentId, "root");
		assert.equal(status.state, "running");
		assert.equal(status.sessionPath, "/tmp/child.jsonl");
	});

	it("delivers steer requests directly to the resident child", async () => {
		const agent = new FakeAgent();
		const bridge = new ExternalControlBridge(agent, {
			profile: "implementer",
			parentPid: process.pid,
			treeId: "tree-1",
			parentAgentId: "root",
		});
		bridges.push(bridge);
		bridge.start();
		const dir = path.join(bridge.controlDir, "control", "steer-requests");
		fs.writeFileSync(
			path.join(dir, "0001.json"),
			JSON.stringify({ type: "steer", id: "s1", message: "focus on the build error", source: "test" }),
		);
		await eventually(() => agent.messages.length === 1);
		assert.deepEqual(agent.messages, ["focus on the build error"]);
		const ack = JSON.parse(fs.readFileSync(path.join(bridge.controlDir, "control", "acks", "s1.json"), "utf8"));
		assert.equal(ack.ok, true);
	});

	it("accepts an explicit stop request and has no pause/deadline command", async () => {
		const agent = new FakeAgent();
		const bridge = new ExternalControlBridge(agent, {
			profile: "implementer",
			parentPid: process.pid,
			treeId: "tree-1",
			parentAgentId: "root",
		});
		bridges.push(bridge);
		bridge.start();
		fs.writeFileSync(
			path.join(bridge.controlDir, "control", "stop.json"),
			JSON.stringify({ type: "stop", id: "x1", source: "test" }),
		);
		await eventually(() => agent.stopCalls === 1);
		assert.equal(agent.status, "stopped");
	});
});

/**
 * Resident-aware fake: mirrors AgentProcess.stop() early-return semantics
 * (a settled agent keeps its reported status) plus the markStopped()
 * terminal marker, so bridge/registry wiring is exercised faithfully.
 */
class ResidentFakeAgent implements ExternallyControllableAgent {
	readonly agentId = "max";
	readonly label = "implementer";
	readonly startedAt = Date.now();
	readonly model = "provider/model";
	readonly thinking = "medium";
	persistent: boolean;
	status: "queued" | "running" | "completed" | "failed" | "stopped" = "running";
	awaitingParent = false;
	sessionPath = "/tmp/child.jsonl";
	stoppedByControl = false;
	/** Settled by waitForCompletion (child gone, reported status terminal-ish). */
	done = false;
	stopCalls = 0;

	constructor(persistent = false) {
		this.persistent = persistent;
	}

	async sendMessage(): Promise<boolean> {
		return true;
	}

	async stop(): Promise<void> {
		this.stopCalls++;
		if (this.done) return; // already settled — reported status untouched
		this.status = "stopped";
		this.stoppedByControl = true;
	}

	markStopped(): void {
		this.stoppedByControl = true;
		if (this.status === "stopped" || this.status === "failed") return;
		this.status = "stopped";
	}
}

function readState(bridge: ExternalControlBridge): string {
	return (JSON.parse(fs.readFileSync(bridge.statusPath, "utf8")) as { state: string }).state;
}

function readStatus(bridge: ExternalControlBridge): { state: string; updatedAt: number } {
	return JSON.parse(fs.readFileSync(bridge.statusPath, "utf8")) as { state: string; updatedAt: number };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function testMetadata(): { profile: string; parentPid: number; treeId: string; parentAgentId: string } {
	return { profile: "implementer", parentPid: process.pid, treeId: "tree-1", parentAgentId: "root" };
}

describe("ExternalControlBridge — stopped residents wind down", () => {
	it("a completed persistent agent removed via stopAndRemove ends stopped with no further writes", async () => {
		// Settled persistent agent: stop()'s early return leaves completed,
		// which the bridge maps to idle (the bug: idle forever after stop).
		const agent = new ResidentFakeAgent(true);
		agent.done = true;
		agent.status = "completed";
		const registry = new AgentRegistry({ notify: () => {} });
		registry.register(agent);
		// Production wiring (index.ts): the bridge stop action delegates to
		// the registry's explicit-stop path.
		const bridge = new ExternalControlBridge(agent, testMetadata(), {
			stop: async () => {
				await registry.stopAndRemove(agent.agentId);
			},
		});
		bridges.push(bridge);
		bridge.start();
		await eventually(() => readState(bridge) === "idle");

		assert.equal(await registry.stopAndRemove(agent.agentId), true);
		assert.equal(agent.status, "stopped");
		await eventually(() => readState(bridge) === "stopped");
		const frozen = fs.readFileSync(bridge.statusPath, "utf8");
		await sleep(550); // >2 ticks at the 200 ms cadence
		assert.equal(fs.readFileSync(bridge.statusPath, "utf8"), frozen, "bridge stopped polling: no further writes");
	});

	it("a normal non-resident completion still ends at completed with its bridge stopped", async () => {
		const agent = new ResidentFakeAgent(false);
		const registry = new AgentRegistry({ notify: () => {} });
		registry.register(agent);
		const bridge = new ExternalControlBridge(agent, testMetadata());
		bridges.push(bridge);
		bridge.start();
		await eventually(() => readState(bridge) === "running");

		// Normal completion path: settle first (done), then complete().
		agent.done = true;
		agent.status = "completed";
		await registry.complete(agent, {
			status: "completed",
			output: "done",
			stats: { tokens: 1, toolUses: 0, durationMs: 1 },
		});

		assert.equal(agent.status, "completed", "complete() must not relabel as stopped");
		await eventually(() => readState(bridge) === "completed");
		const frozen = fs.readFileSync(bridge.statusPath, "utf8");
		await sleep(550);
		assert.equal(fs.readFileSync(bridge.statusPath, "utf8"), frozen, "bridge stopped polling: no further writes");
	});

	it("a resident agent left idle (never stopped) keeps heartbeating idle", async () => {
		const agent = new ResidentFakeAgent(true);
		agent.done = true;
		agent.status = "completed";
		const bridge = new ExternalControlBridge(agent, testMetadata());
		bridges.push(bridge);
		bridge.start();

		await eventually(() => readState(bridge) === "idle");
		const first = readStatus(bridge);
		await sleep(500);
		const second = readStatus(bridge);
		assert.equal(second.state, "idle");
		assert.ok(second.updatedAt > first.updatedAt, "idle heartbeat continues while resident");
	});
});
