import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childIdentityEnvironment } from "../spawn-identity.js";

describe("spawned agent identity contract", () => {
	it("passes the exact known Pi child environment keys and allowed profiles", () => {
		const environment = childIdentityEnvironment(
			"kai",
			{ name: "implementer", allowedSubagents: ["explore", "debugging-duck"] },
			"tree-123",
			"root",
			"ancestor",
		);
		assert.deepEqual(environment, {
			PI_SUBAGENT_AGENT_ID: "kai",
			PI_SUBAGENT_PROFILE: "implementer",
			PI_SUBAGENT_ALLOWED_SUBAGENTS: '["explore","debugging-duck"]',
			PI_SUBAGENT_TREE_ID: "tree-123",
			PI_SUBAGENT_ANCESTOR_IDS: "kai,root,ancestor",
		});
	});

	it("deduplicates ancestor identities without altering the tree token", () => {
		const environment = childIdentityEnvironment(
			"zoe",
			{ name: "explore", allowedSubagents: [] },
			"tree-safe",
			"kai",
			"kai,zoe,amy",
		);
		assert.equal(environment.PI_SUBAGENT_ANCESTOR_IDS, "zoe,kai,amy");
		assert.equal(environment.PI_SUBAGENT_TREE_ID, "tree-safe");
		assert.equal(environment.PI_SUBAGENT_ALLOWED_SUBAGENTS, "[]");
	});
});
