import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const parentDeliverySource = readFileSync(new URL("../parent-delivery.ts", import.meta.url), "utf8");
const supervisionReminderSource = readFileSync(new URL("../supervision-reminder.ts", import.meta.url), "utf8");
const monitoringSource = readFileSync(new URL("../monitoring-tools.ts", import.meta.url), "utf8");
const toolSource = `${indexSource}\n${monitoringSource}\n${parentDeliverySource}\n${supervisionReminderSource}`;
const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("supervision wording stays plain", () => {
	it("keeps triage jargon out of index.ts reader-facing strings", () => {
		assert.ok(!/\bhealthy\b/i.test(toolSource), "tool sources still contain HEALTHY");
		assert.ok(!/\bstalled\b/i.test(toolSource), "tool sources still contain STALLED");
		assert.ok(!/\bdrifting\b/i.test(toolSource), "tool sources still contain DRIFTING");
	});

	it("keeps triage jargon out of README reader-facing strings", () => {
		assert.ok(!/\bhealthy\b/i.test(readmeSource), "README.md still contains HEALTHY");
		assert.ok(!/\bstalled\b/i.test(readmeSource), "README.md still contains STALLED");
		assert.ok(!/\bdrifting\b/i.test(readmeSource), "README.md still contains DRIFTING");
	});

	it("guides progress checks with concrete signals and actions", () => {
		for (const [name, source] of [
			["extension tool sources", toolSource],
			["README.md", readmeSource],
		] as const) {
			assert.ok(source.includes("making real progress"), `${name} lost the progress question`);
			assert.ok(source.includes("assigned scope and last correction"), `${name} lost the scope comparison`);
			assert.ok(source.includes("repeated failure"), `${name} lost the repeating signal`);
			assert.ok(source.includes("scope drift"), `${name} lost the off-task signal`);
			assert.ok(source.includes("concrete blocker"), `${name} lost the blocker signal`);
			assert.ok(
				source.includes("without reassurance messages, document updates, or repeated audits"),
				`${name} lost the low-overhead aligned path`,
			);
			assert.ok(
				source.includes("A timeout or long-running command alone is not a stall"),
				`${name} treats a timeout as a failure`,
			);
			assert.ok(source.includes("Use completion results already delivered"), `${name} lost completion reuse`);
			assert.ok(source.includes("process/job wait"), `${name} lost ordinary process waiting`);
			assert.ok(source.includes("steer"), `${name} lost the steer action`);
			assert.ok(source.includes("inspect"), `${name} lost the inspect action`);
			assert.ok(source.includes("stop"), `${name} lost the stop action`);
		}
	});

	it("keeps the supervision mechanism facts intact", () => {
		assert.ok(supervisionReminderSource.includes('"subagent-supervision"'), "reminder customType changed");
		assert.ok(
			supervisionReminderSource.includes("normally a 150-second window"),
			"reminder lost the 150-second cadence",
		);
		assert.ok(toolSource.includes("unread transcript page"), "guidelines lost unread transcript paging");
		assert.ok(toolSource.includes("180-second supervision window"), "guidelines lost the 180-second default");
		assert.ok(readmeSource.includes("180-second default"), "README lost the 180-second default");
		assert.ok(readmeSource.includes("get_entries(since)"), "README lost the stable entry cursor contract");
	});

	it("delivers pending updates through a tool result or the idle fallback", () => {
		assert.ok(parentDeliverySource.includes('pi.on("turn_end", () => {'));
		assert.ok(parentDeliverySource.includes('pi.on("tool_result", (event) => {'));
		assert.ok(parentDeliverySource.includes("registry.takePendingForToolResult()"));
		assert.ok(parentDeliverySource.includes('pi.on("agent_settled", () => {'));
		assert.ok(parentDeliverySource.includes("registry.parentBecameIdle()"));
		assert.ok(!parentDeliverySource.includes('pi.on("agent_end", () => registry.parentBecameIdle())'));
		assert.ok(supervisionReminderSource.includes("current !== agent"), "stale reminder re-check missing");
	});

	it("records resumed child completion before normal cleanup", () => {
		const start = indexSource.indexOf("onIdle: (outcome, generation) => {");
		const end = indexSource.indexOf("// Where live output goes", start);
		assert.ok(start >= 0 && end > start, "could not locate resumed-child lifecycle block");
		const onIdle = indexSource.slice(start, end);
		assert.ok(onIdle.includes('wakeCompletion("completed", generation)'), "resumed completion is not collected");
		assert.ok(
			onIdle.includes("registry.complete(agent, completion)"),
			"resumed completion bypasses normal completion policy",
		);
		assert.ok(
			!onIdle.includes("registry.stopAndRemove(agentId)"),
			"resumed completion can still be relabeled as stopped",
		);
	});
});
