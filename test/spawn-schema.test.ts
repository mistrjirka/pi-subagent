import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import { buildSpawnParamsSchema, canDelegate, shouldRunInBackground } from "../index.js";

function keys(schema: TSchema): string[] {
	return Object.keys((schema as { properties: Record<string, unknown> }).properties);
}

describe("buildSpawnParamsSchema", () => {
	it("root exposes only role/task/lifecycle controls", () => {
		const k = keys(buildSpawnParamsSchema(false));
		assert.deepEqual(k.sort(), ["agent", "label", "persistent", "prompt", "run_in_background"].sort());
		for (const forbidden of ["model", "thinking", "tools", "timeoutMs", "max_turns", "toolBudget"]) {
			assert.ok(!k.includes(forbidden), `model-facing spawn must not expose ${forbidden}`);
		}
	});

	it("agent and prompt are required; label is optional", () => {
		const schema = buildSpawnParamsSchema(false) as unknown as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		assert.ok(schema.required?.includes("agent"));
		assert.ok(schema.required?.includes("prompt"));
		assert.ok(!schema.required?.includes("label"));
	});

	it("nested agents cannot request background execution", () => {
		const k = keys(buildSpawnParamsSchema(true));
		assert.ok(!k.includes("run_in_background"));
		assert.deepEqual(k.sort(), ["agent", "label", "persistent", "prompt"].sort());
	});
});

describe("root spawn scheduling", () => {
	it("defaults omitted background choice to asynchronous execution", () => {
		assert.equal(shouldRunInBackground(false, undefined), true);
		assert.equal(shouldRunInBackground(false, true), true);
		assert.equal(shouldRunInBackground(false, false), false);
	});

	it("keeps nested spawns foreground regardless of request", () => {
		assert.equal(shouldRunInBackground(true, undefined), false);
		assert.equal(shouldRunInBackground(true, true), false);
		assert.equal(shouldRunInBackground(true, false), false);
	});
});

describe("delegation tool visibility", () => {
	it("root always exposes delegation", () => {
		assert.equal(canDelegate(false, []), true);
	});

	it("leaf children do not receive agent_spawn", () => {
		assert.equal(canDelegate(true, []), false);
	});

	it("children with explicitly allowed profiles receive agent_spawn", () => {
		assert.equal(canDelegate(true, ["explore"]), true);
	});
});
