import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WAIT_TIMEOUT_SECONDS, resolveWaitTimeoutSeconds } from "../wait-policy.js";

describe("agent_wait timeout defaults", () => {
	it("defaults omitted waits to a 150-second supervision window", () => {
		assert.equal(DEFAULT_WAIT_TIMEOUT_SECONDS, 150);
		assert.equal(resolveWaitTimeoutSeconds(undefined), 150);
	});

	it("preserves an explicit supervision window or immediate snapshot", () => {
		assert.equal(resolveWaitTimeoutSeconds(150), 150);
		assert.equal(resolveWaitTimeoutSeconds(0), 0);
	});
});
