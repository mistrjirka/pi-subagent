import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentNameAllocator } from "../agent-name-allocator.js";
import { DiagnosticDeduplicator } from "../diagnostic-dedup.js";
import type { AgentSettlement, RegisteredAgent } from "../registry-contracts.js";
import { checkpointRoster, describeMessageTargets } from "../registry-roster.js";

function agent(id: string, state: RegisteredAgent["status"], task = "Task"): RegisteredAgent {
	return {
		agentId: id,
		label: id,
		taskSummary: task,
		status: state,
		stoppedByControl: false,
		async stop() {},
		markStopped() {},
	};
}

describe("extracted registry services", () => {
	it("reserves ancestor names and assigns unique short names", () => {
		const names = new AgentNameAllocator(["kai", "zoe", "bad/slash", "kai"]);
		const allocated = Array.from({ length: 25 }, () => names.next());
		assert.equal(new Set(allocated).size, allocated.length);
		assert.ok(allocated.every((value) => /^[a-z]{1,64}$/.test(value)));
		assert.ok(!allocated.includes("kai"));
		assert.ok(!allocated.includes("zoe"));
	});

	it("suppresses only identical successfully sent diagnostics for ten minutes", () => {
		const dedup = new DiagnosticDeduplicator();
		assert.equal(dedup.wasSentRecently("max", "status", 1000), false);
		dedup.recordSent("max", " status \n", 1000);
		assert.equal(dedup.wasSentRecently("max", "status", 1001), true);
		assert.equal(dedup.wasSentRecently("zoe", "status", 1001), false);
		assert.equal(dedup.wasSentRecently("max", "status", 601_000), false);
	});

	it("projects the same direct active roster without mutating the source map", () => {
		const children = new Map([
			["ari", agent("ari", "running", "Investigate cache")],
			["kim", agent("kim", "completed", "Done, resident")],
			["zoe", agent("zoe", "failed")],
		]);
		const first = checkpointRoster(children);
		assert.deepEqual(
			first.agents.map((entry) => [entry.id, entry.state]),
			[
				["ari", "running"],
				["kim", "idle"],
			],
		);
		assert.equal(first.total, 2);
		assert.equal(children.size, 3);
	});

	it("describes deliverable and finished children with current settlement state", () => {
		const children = new Map([["ari", agent("ari", "running")]]);
		const settlement: AgentSettlement = {
			completion: { status: "completed", output: "done", stats: { tokens: 0, toolUses: 0, durationMs: 0 } },
		};
		const settled = new Map([["kim", settlement]]);
		const text = describeMessageTargets(children, settled, "kim");
		assert.match(text, /@kim finished/);
		assert.match(text, /@ari/);
		assert.match(text, /cannot receive agent_send/);
	});
});
