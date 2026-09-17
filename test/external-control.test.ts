import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ExternalControlBridge, type ExternallyControllableAgent } from "../external-control.js";

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
