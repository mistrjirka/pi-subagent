import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("supervision wording stays plain", () => {
	it("keeps triage jargon out of index.ts reader-facing strings", () => {
		assert.ok(!/\bhealthy\b/i.test(indexSource), "index.ts still contains HEALTHY");
		assert.ok(!/\bstalled\b/i.test(indexSource), "index.ts still contains STALLED");
		assert.ok(!/\bdrifting\b/i.test(indexSource), "index.ts still contains DRIFTING");
	});

	it("keeps triage jargon out of README reader-facing strings", () => {
		assert.ok(!/\bhealthy\b/i.test(readmeSource), "README.md still contains HEALTHY");
		assert.ok(!/\bstalled\b/i.test(readmeSource), "README.md still contains STALLED");
		assert.ok(!/\bdrifting\b/i.test(readmeSource), "README.md still contains DRIFTING");
	});

	it("guides progress checks with concrete signals and actions", () => {
		for (const [name, source] of [
			["index.ts", indexSource],
			["README.md", readmeSource],
		] as const) {
			assert.ok(source.includes("making real progress"), `${name} lost the progress question`);
			assert.ok(source.includes("repeating itself"), `${name} lost the repeating signal`);
			assert.ok(source.includes("wandered off the task"), `${name} lost the off-task signal`);
			assert.ok(source.includes("steer"), `${name} lost the steer action`);
			assert.ok(source.includes("inspect"), `${name} lost the inspect action`);
			assert.ok(source.includes("stop"), `${name} lost the stop action`);
		}
	});

	it("keeps the supervision mechanism facts intact", () => {
		assert.ok(indexSource.includes('"subagent-supervision"'), "reminder customType changed");
		assert.ok(indexSource.includes("normally a 150-second window"), "reminder lost the 150-second cadence");
		assert.ok(indexSource.includes("unread transcript page"), "guidelines lost unread transcript paging");
		assert.ok(indexSource.includes("180-second supervision window"), "guidelines lost the 180-second default");
		assert.ok(readmeSource.includes("180-second default"), "README lost the 180-second default");
		assert.ok(readmeSource.includes("get_entries(since)"), "README lost the stable entry cursor contract");
	});

	it("flushes deferred completion announcements only after the parent fully settles", () => {
		assert.ok(indexSource.includes('pi.on("agent_settled", () => registry.parentBecameIdle())'));
		assert.ok(!indexSource.includes('pi.on("agent_end", () => registry.parentBecameIdle())'));
		assert.ok(indexSource.includes("current !== agent"), "stale reminder re-check missing");
	});
});
