import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatAgo, formatClockTime, formatStamp } from "../time.js";
import {
	formatRecentActivity,
	formatTranscript,
	formatTranscriptMessage,
	getMonitoringTranscript,
	recentSessionMessages,
} from "../transcript.js";

describe("transcript formatting", () => {
	it("shows user, assistant tool calls, and tool results while hiding raw thinking", () => {
		const messages = [
			{ role: "user", content: "implement it" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain of thought" },
					{ type: "text", text: "Inspecting files." },
					{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
				],
			},
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] },
		];
		const text = formatTranscript(messages);
		assert.match(text, /user: implement it/);
		assert.match(text, /assistant: \[thinking\]/);
		assert.match(text, /\[tool call\] read/);
		assert.match(text, /tool result \(read\): file body/);
		assert.doesNotMatch(text, /private chain of thought/);
	});

	it("returns the most recent messages and marks omitted history", () => {
		const messages = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const text = formatTranscript(messages, { maxMessages: 3 });
		assert.match(text, /earlier transcript omitted/);
		assert.doesNotMatch(text, /m0/);
		assert.match(text, /m5/);
		assert.match(text, /m7/);
	});

	it("formats a compact recent activity trail", () => {
		const text = formatRecentActivity([
			{ kind: "thinking" },
			{ kind: "tool", name: "read", args: "src/a.ts" },
			{ kind: "text", text: "Found the owning helper." },
			{ kind: "tool", name: "bash", args: "npm run typecheck" },
		]);
		assert.match(text, /\[thinking\]/);
		assert.match(text, /\[tool call\] read src\/a\.ts/);
		assert.match(text, /assistant: Found the owning helper/);
		assert.match(text, /npm run typecheck/);
	});

	it("marks failed tool results", () => {
		assert.equal(
			formatTranscriptMessage({
				role: "toolResult",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "boom" }],
			}),
			"tool result (bash ERROR): boom",
		);
	});
});

describe("monitoring transcript fallbacks", () => {
	it("uses live RPC messages when available", async () => {
		const snapshot = await getMonitoringTranscript({
			getMessages: async () => [{ role: "user", content: "live task" }],
		});
		assert.equal(snapshot.source, "rpc");
		assert.match(snapshot.text, /live task/);
	});

	it("falls back to the persisted session when get_messages fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-transcript-"));
		const sessionPath = join(dir, "child.jsonl");
		try {
			writeFileSync(
				sessionPath,
				`${[
					JSON.stringify({ type: "session", id: "s1" }),
					JSON.stringify({ type: "message", message: { role: "user", content: "persisted task" } }),
					JSON.stringify({
						type: "message",
						message: {
							role: "toolResult",
							toolName: "bash",
							isError: false,
							content: [{ type: "text", text: "build ok" }],
						},
					}),
				].join("\n")}\n`,
			);
			const snapshot = await getMonitoringTranscript({
				getMessages: async () => {
					throw new Error("RPC timeout waiting for get_messages");
				},
				sessionPath,
			});
			assert.equal(snapshot.source, "session");
			assert.match(snapshot.text, /get_messages unavailable/);
			assert.match(snapshot.text, /persisted task/);
			assert.match(snapshot.text, /build ok/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the live event trace when messages are empty", async () => {
		const snapshot = await getMonitoringTranscript({
			getMessages: async () => [],
			getEvents: () => [
				{ kind: "text", text: "Checking build." },
				{ kind: "tool", name: "bash", args: "npm run typecheck" },
			],
		});
		assert.equal(snapshot.source, "events");
		assert.match(snapshot.text, /Checking build/);
		assert.match(snapshot.text, /npm run typecheck/);
	});

	it("does not silently report an RPC failure as an empty transcript", async () => {
		const snapshot = await getMonitoringTranscript({
			getMessages: async () => {
				throw new Error("unsupported get_messages");
			},
		});
		assert.equal(snapshot.source, "none");
		assert.match(snapshot.text, /transcript unavailable/);
		assert.match(snapshot.text, /unsupported get_messages/);
	});
});

describe("transcript time formatting", () => {
	const pad = (n: number) => String(n).padStart(2, "0");

	it("renders the system-local wall clock for a known instant, never UTC", () => {
		// Stored as UTC on the wire; the parent reads the machine's own clock
		// (on UTC+2 this instant is 17:42:03 local, not 15:42:03Z).
		const ms = Date.parse("2026-05-10T15:42:03.000Z");
		const at = new Date(ms);
		// now === ms pins the same-day branch portably (no midnight edge in any timezone).
		assert.equal(formatClockTime(ms, ms), `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`);
	});

	it("renders cross-day instants as MM-DD HH:MM in local fields", () => {
		const ms = Date.parse("2026-05-10T15:42:03.000Z");
		// Any 36 h span crosses a local midnight, so the day branch holds in every timezone.
		const later = ms + 36 * 3_600_000;
		const at = new Date(ms);
		assert.equal(
			formatClockTime(ms, later),
			`${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
		);
	});

	it("formats relative ages across every boundary", () => {
		const now = 1_800_000_000_000;
		assert.equal(formatAgo(now, now), "just now");
		assert.equal(formatAgo(now - 4_999, now), "just now");
		assert.equal(formatAgo(now - 5_000, now), "5s ago");
		assert.equal(formatAgo(now - 12_000, now), "12s ago");
		assert.equal(formatAgo(now - 59_000, now), "59s ago");
		assert.equal(formatAgo(now - 60_000, now), "1m ago");
		assert.equal(formatAgo(now - 3 * 60_000, now), "3m ago");
		assert.equal(formatAgo(now - 2 * 3_600_000, now), "2h ago");
		assert.equal(formatAgo(now - 3 * 86_400_000, now), "3d ago");
		assert.equal(formatAgo(now + 60_000, now), "just now");
	});

	it("combines clock and age with one separator", () => {
		const now = 1_800_000_000_000;
		assert.equal(formatStamp(now - 12_000, now), `${formatClockTime(now - 12_000, now)} · 12s ago`);
	});

	it("prefixes transcript lines carrying a numeric epoch timestamp", () => {
		const now = 1_800_000_000_000;
		const ts = now - 12_000;
		assert.equal(
			formatTranscript([{ role: "user", content: "live task", timestamp: ts }], {}, now),
			`[${formatStamp(ts, now)}] user: live task`,
		);
	});

	it("prefixes transcript lines carrying an ISO timestamp identically", () => {
		const now = 1_800_000_000_000;
		const ts = now - 12_000;
		const iso = new Date(ts).toISOString();
		assert.equal(
			formatTranscript([{ role: "user", content: "live task", timestamp: iso }], {}, now),
			`[${formatStamp(ts, now)}] user: live task`,
		);
		assert.equal(
			formatTranscript([{ role: "user", content: "live task", ts }], {}, now),
			`[${formatStamp(ts, now)}] user: live task`,
		);
		assert.equal(
			formatTranscript([{ role: "user", content: "live task", createdAt: iso }], {}, now),
			`[${formatStamp(ts, now)}] user: live task`,
		);
	});

	it("renders lines without a timestamp exactly as before (no empty brackets)", () => {
		assert.equal(formatTranscriptMessage({ role: "user", content: "plain" }), "user: plain");
		assert.equal(formatTranscript([{ role: "user", content: "plain" }]), "user: plain");
	});

	it("ignores malformed timestamps instead of rendering NaN", () => {
		const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, "not-a-date", "", {}, []];
		for (const timestamp of bad) {
			assert.equal(formatTranscriptMessage({ role: "user", content: "hi", timestamp }), "user: hi");
		}
	});

	it("stamps activity lines when ts is present", () => {
		const now = 1_800_000_000_000;
		const ts = now - 65_000;
		assert.equal(
			formatRecentActivity(
				[
					{ kind: "thinking", ts },
					{ kind: "tool", name: "read", args: "src/a.ts", ts },
					{ kind: "text", text: "done", ts },
				],
				20,
				4_000,
				now,
			),
			[
				`[${formatStamp(ts, now)}] [thinking]`,
				`[${formatStamp(ts, now)}] [tool call] read src/a.ts`,
				`[${formatStamp(ts, now)}] assistant: done`,
			].join("\n\n"),
		);
	});

	it("leaves activity lines unchanged when ts is absent", () => {
		assert.equal(
			formatRecentActivity([
				{ kind: "thinking" },
				{ kind: "tool", name: "read", args: "src/a.ts" },
				{ kind: "text", text: "hi" },
			]),
			"[thinking]\n\n[tool call] read src/a.ts\n\nassistant: hi",
		);
	});

	it("shows the record time on the persisted session fallback (post-RPC-failure path)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-transcript-ts-"));
		const sessionPath = join(dir, "child.jsonl");
		const ms = Date.parse("2026-05-10T15:42:03.000Z");
		try {
			writeFileSync(
				sessionPath,
				`${JSON.stringify({ type: "message", id: "m1", timestamp: new Date(ms).toISOString(), message: { role: "user", content: "persisted task" } })}\n`,
			);
			const snapshot = await getMonitoringTranscript({
				getMessages: async () => {
					throw new Error("RPC timeout waiting for get_messages");
				},
				sessionPath,
			});
			assert.equal(snapshot.source, "session");
			assert.match(snapshot.text, /\[.* · .* ago\] user: persisted task/);
			const clock = formatClockTime(ms);
			assert.ok(snapshot.text.includes(`[${clock}`), `persisted line uses the system-local clock (${clock})`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recentSessionMessages keeps the inner time, attaches the outer, drops malformed", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagent-transcript-seam-"));
		const sessionPath = join(dir, "child.jsonl");
		const outerMs = Date.parse("2026-05-10T15:42:03.000Z");
		const innerMs = outerMs - 60_000;
		try {
			writeFileSync(
				sessionPath,
				`${[
					JSON.stringify({
						type: "message",
						timestamp: new Date(outerMs).toISOString(),
						message: { role: "user", content: "outer time" },
					}),
					JSON.stringify({
						type: "message",
						timestamp: new Date(outerMs).toISOString(),
						message: { role: "user", content: "inner wins", timestamp: innerMs },
					}),
					JSON.stringify({
						type: "message",
						timestamp: "garbage",
						message: { role: "user", content: "no time" },
					}),
				].join("\n")}\n`,
			);
			const messages = recentSessionMessages(sessionPath);
			assert.equal(messages.length, 3);
			const [outer, inner, timeless] = messages as Array<Record<string, unknown>>;
			assert.equal(outer.content, "outer time");
			assert.equal(outer.timestamp, outerMs);
			assert.equal(inner.timestamp, innerMs);
			assert.equal(timeless.content, "no time");
			assert.ok(!("timestamp" in timeless));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
