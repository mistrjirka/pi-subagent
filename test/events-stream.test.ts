/**
 * Tests for the live child event stream (`<controlDir>/events.jsonl`).
 *
 * The frozen contract: a regular non-symlink 0600 file, created empty when
 * the bridge starts, appended to only, `\n`-terminated lines, one JSON object
 * per line (v/seq/ts/runId/kind + kind-specific fields), removed by cleanup().
 * Writer rules: kind/blockId-change flush, ≤250 ms flush, ~4 KB flush, 2 MB
 * cap that drops thinking/text but keeps tool lines, terminal flush in
 * stopPolling(). Reader semantics mirror the PiTTy tail: same (runId, blockId)
 * accumulates, new blockId starts a new item, tool_end matches tool_start by
 * toolCallId, unknown kinds and a torn final line are ignored.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { interpretEvent } from "../event-interpret.js";
import { type ChildStreamLine, ExternalControlBridge, type ExternallyControllableAgent } from "../external-control.js";

class FakeAgent implements ExternallyControllableAgent {
	readonly agentId = "max";
	readonly label = "implementer";
	readonly startedAt = Date.now();
	status: "queued" | "running" | "completed" | "failed" | "stopped" = "running";
	async sendMessage(): Promise<boolean> {
		return true;
	}
	async stop(): Promise<void> {
		this.status = "stopped";
	}
}

const bridges: ExternalControlBridge[] = [];
afterEach(() => {
	for (const bridge of bridges.splice(0)) bridge.cleanup();
});

function makeBridge(options?: { eventsCapBytes?: number; flushIntervalMs?: number; maxBufferedBytes?: number }) {
	const bridge = new ExternalControlBridge(
		new FakeAgent(),
		{ profile: "implementer", parentPid: process.pid, treeId: "tree-1", parentAgentId: "root" },
		{},
		options,
	);
	bridges.push(bridge);
	return bridge;
}

/** Feed one raw wire delta through the real interpreter into the appender. */
function feed(bridge: ExternalControlBridge, assistantMessageEvent: Record<string, unknown>): void {
	for (const ev of interpretEvent({ type: "message_update", assistantMessageEvent })) bridge.appendEvents(ev);
}

function readLines(bridge: ExternalControlBridge): ChildStreamLine[] {
	const raw = fs.readFileSync(bridge.eventsPath, "utf8");
	assert.ok(raw === "" || raw.endsWith("\n"), "every line is newline-terminated");
	const lines: ChildStreamLine[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		lines.push(validatedLine(JSON.parse(line)));
	}
	return lines;
}

/** Explicit narrowing for untrusted file content — no any/casts. */
function validatedLine(value: unknown): ChildStreamLine {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), "line is an object");
	const v = value as Record<string, unknown>;
	assert.equal(v.v, 1);
	assert.ok(typeof v.seq === "number" && Number.isInteger(v.seq) && v.seq >= 1, "seq is a positive integer");
	assert.ok(typeof v.ts === "number", "ts is a number");
	assert.ok(typeof v.runId === "string" && v.runId, "runId is a string");
	assert.ok(
		v.kind === "thinking" || v.kind === "text" || v.kind === "tool_start" || v.kind === "tool_end",
		"known kind",
	);
	const line: ChildStreamLine = { v: 1, seq: v.seq, ts: v.ts, runId: v.runId, kind: v.kind };
	if (v.blockId !== undefined) {
		assert.ok(typeof v.blockId === "string", "blockId is a string");
		line.blockId = v.blockId;
	}
	if (v.text !== undefined) {
		assert.ok(typeof v.text === "string", "text is a string");
		line.text = v.text;
	}
	if (v.toolName !== undefined) {
		assert.ok(typeof v.toolName === "string", "toolName is a string");
		line.toolName = v.toolName;
	}
	if (v.toolCallId !== undefined) {
		assert.ok(typeof v.toolCallId === "string", "toolCallId is a string");
		line.toolCallId = v.toolCallId;
	}
	if ((line.kind === "thinking" || line.kind === "text") && (line.blockId === undefined || line.text === undefined)) {
		assert.fail(`${line.kind} lines require blockId and text`);
	}
	if ((line.kind === "tool_start" || line.kind === "tool_end") && line.toolName === undefined) {
		assert.fail(`${line.kind} lines require toolName`);
	}
	return line;
}

async function eventually(predicate: () => boolean, timeout = 2000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeout) throw new Error("condition did not become true");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("events.jsonl — lifecycle and hardening", () => {
	it("is created empty as a direct 0600 non-symlink child of the controlDir", () => {
		const bridge = makeBridge();
		assert.equal(path.dirname(bridge.eventsPath), bridge.controlDir, "direct child, not nested");
		assert.ok(!bridge.eventsPath.includes(`${path.sep}control${path.sep}`), "not under the steer/stop inbox");
		assert.equal(fs.readFileSync(bridge.eventsPath, "utf8"), "", "created empty");
		const stat = fs.lstatSync(bridge.eventsPath);
		assert.ok(stat.isFile() && !stat.isSymbolicLink(), "regular file, not a symlink");
		assert.equal(stat.mode & 0o777, 0o600, "mode 0600");
	});

	it("is removed by cleanup() with the rest of the controlDir", () => {
		const bridge = makeBridge();
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "hi" });
		bridge.flushEvents();
		assert.ok(fs.existsSync(bridge.eventsPath));
		const dir = bridge.controlDir;
		bridge.cleanup();
		bridges.splice(bridges.indexOf(bridge), 1);
		assert.ok(!fs.existsSync(dir), "controlDir removed");
	});

	it("never rewrites history: flushes only append", () => {
		const bridge = makeBridge();
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "one" });
		bridge.flushEvents();
		const first = fs.readFileSync(bridge.eventsPath, "utf8");
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "two" });
		bridge.flushEvents();
		const second = fs.readFileSync(bridge.eventsPath, "utf8");
		assert.ok(second.startsWith(first), "earlier bytes untouched");
	});
});

describe("events.jsonl — envelope and writer rules", () => {
	it("emits one envelope line per kind with seq from 1 and the agent runId", () => {
		const bridge = makeBridge();
		feed(bridge, { type: "thinking_delta", contentIndex: 0, delta: "hmm" });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "hello" });
		feed(bridge, { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" });
		feed(bridge, {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { name: "bash", arguments: { command: "ls" }, id: "call-1" },
		});
		bridge.flushEvents();
		const lines = readLines(bridge);
		assert.equal(lines.length, 4);
		assert.deepEqual(
			lines.map((l) => l.seq),
			[1, 2, 3, 4],
		);
		for (const line of lines) assert.equal(line.runId, "max");

		const [thinking, text, start, end] = lines;
		assert.equal(thinking?.kind, "thinking");
		assert.equal(thinking?.blockId, "think-0");
		assert.equal(thinking?.text, "hmm");
		assert.equal(text?.kind, "text");
		assert.equal(text?.blockId, "text-0");
		assert.equal(text?.text, "hello");
		assert.equal(start?.kind, "tool_start");
		assert.equal(start?.toolName, "bash");
		assert.equal(start?.toolCallId, "call-1");
		assert.equal(end?.kind, "tool_end");
		assert.equal(end?.toolName, "bash");
		assert.equal(end?.toolCallId, "call-1");
	});

	it("a new blockId starts a new in-flight item (think-0 vs think-1)", () => {
		const bridge = makeBridge();
		feed(bridge, { type: "thinking_delta", contentIndex: 0, delta: "a" });
		feed(bridge, { type: "thinking_delta", contentIndex: 1, delta: "b" });
		bridge.flushEvents();
		const lines = readLines(bridge);
		assert.deepEqual(
			lines.map((l) => [l.kind, l.blockId, l.text]),
			[
				["thinking", "think-0", "a"],
				["thinking", "think-1", "b"],
			],
		);
	});

	it("does not write per token: same-block chunks stay buffered until flush", () => {
		const bridge = makeBridge({ flushIntervalMs: 60_000, maxBufferedBytes: 1024 * 1024 });
		for (let i = 0; i < 20; i++) feed(bridge, { type: "text_delta", contentIndex: 0, delta: "tok " });
		assert.equal(fs.readFileSync(bridge.eventsPath, "utf8"), "", "no per-token file writes");
		bridge.flushEvents();
		assert.equal(readLines(bridge).length, 20, "one line per chunk after a single flush");
	});

	it("flushes when the kind changes without an explicit flush", () => {
		const bridge = makeBridge({ flushIntervalMs: 60_000, maxBufferedBytes: 1024 * 1024 });
		feed(bridge, { type: "thinking_delta", contentIndex: 0, delta: "hmm" });
		assert.equal(fs.readFileSync(bridge.eventsPath, "utf8"), "", "still buffered");
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "hi" });
		const lines = readLines(bridge);
		assert.equal(lines.length, 1, "kind change flushed the thinking line");
		assert.equal(lines[0]?.kind, "thinking");
	});

	it("flushes at most every 250 ms by default (timer, not per token)", async () => {
		const bridge = makeBridge({ flushIntervalMs: 40 });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "slow" });
		await eventually(() => fs.readFileSync(bridge.eventsPath, "utf8") !== "");
		assert.equal(readLines(bridge).length, 1);
	});

	it("flushes when the buffered bytes exceed ~4 KB", () => {
		const bridge = makeBridge({ flushIntervalMs: 60_000, maxBufferedBytes: 200 });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "x".repeat(60) });
		assert.equal(fs.readFileSync(bridge.eventsPath, "utf8"), "", "under the budget: buffered");
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "y".repeat(60) });
		assert.ok(fs.readFileSync(bridge.eventsPath, "utf8") !== "", "over the budget: flushed");
	});

	it("stopPolling() flushes the buffer (terminal run drains the tail)", () => {
		const bridge = makeBridge({ flushIntervalMs: 60_000, maxBufferedBytes: 1024 * 1024 });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "last words" });
		assert.equal(fs.readFileSync(bridge.eventsPath, "utf8"), "");
		bridge.stopPolling();
		assert.equal(readLines(bridge).length, 1);
	});

	it("ignores non-stream records (settle/markers carry no new chunk)", () => {
		const bridge = makeBridge();
		for (const ev of interpretEvent({ type: "agent_settled" })) bridge.appendEvents(ev);
		feed(bridge, { type: "thinking_delta" });
		feed(bridge, { type: "text_start", contentIndex: 0 });
		feed(bridge, { type: "thinking_end", contentIndex: 0, content: "cumulative" });
		bridge.flushEvents();
		assert.equal(fs.readFileSync(bridge.eventsPath, "utf8"), "", "nothing new, nothing written");
	});
});

describe("events.jsonl — 2 MB cap", () => {
	it("drops thinking/text past the cap but keeps tool_start/tool_end", () => {
		const bridge = makeBridge({ eventsCapBytes: 300, flushIntervalMs: 60_000, maxBufferedBytes: 1024 * 1024 });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "a".repeat(20) });
		bridge.flushEvents();
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "b".repeat(20) });
		bridge.flushEvents();
		const before = readLines(bridge);
		assert.equal(before.length, 2, "under the cap: both text lines written");

		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "past the cap" });
		feed(bridge, { type: "thinking_delta", contentIndex: 0, delta: "also past" });
		feed(bridge, { type: "toolcall_start", contentIndex: 1, id: "call-9", toolName: "bash" });
		feed(bridge, {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { name: "bash", arguments: { command: "ls" }, id: "call-9" },
		});
		bridge.flushEvents();
		const lines = readLines(bridge);
		assert.deepEqual(
			lines.map((l) => l.kind),
			["text", "text", "tool_start", "tool_end"],
			"no notice record invented; the reader falls back to the session file",
		);
		assert.equal(lines[2]?.toolCallId, "call-9");
		assert.equal(lines[3]?.toolCallId, "call-9");
	});
});

describe("events.jsonl — reader semantics (PiTTy contract)", () => {
	type InFlight = {
		runId: string;
		kind: string;
		blockId: string;
		text: string;
		toolName?: string;
		toolCallId?: string;
		open: boolean;
	};

	/** Minimal tail-reader: accumulate same (runId, blockId), match tools by id, ignore the rest. */
	function tailFile(filePath: string): InFlight[] {
		const items: InFlight[] = [];
		const tools = new Map<string, InFlight>();
		for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // torn final line ignored
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const v = parsed as Record<string, unknown>;
			if (v.v !== 1 || typeof v.runId !== "string" || typeof v.kind !== "string") continue;
			if (v.kind === "thinking" || v.kind === "text") {
				if (typeof v.text !== "string" || typeof v.blockId !== "string") continue;
				const last = items.at(-1);
				if (last?.open && last.kind === v.kind && last.blockId === v.blockId && last.runId === v.runId) {
					last.text += v.text;
				} else {
					items.push({ runId: v.runId, kind: v.kind, blockId: v.blockId, text: v.text, open: true });
				}
			} else if (v.kind === "tool_start") {
				if (typeof v.toolName !== "string") continue;
				const row: InFlight = {
					runId: v.runId,
					kind: "tool",
					blockId: "",
					text: "",
					toolName: v.toolName,
					open: true,
				};
				if (typeof v.toolCallId === "string") {
					row.toolCallId = v.toolCallId;
					tools.set(v.toolCallId, row);
				}
				items.push(row);
			} else if (v.kind === "tool_end") {
				const id = typeof v.toolCallId === "string" ? v.toolCallId : undefined;
				const row = id !== undefined ? tools.get(id) : undefined;
				if (row) {
					row.open = false;
					if (typeof v.toolName === "string") row.toolName = v.toolName;
				}
				// tool_end without a matching start: ignored (nothing to finish)
			}
			// unknown kinds ignored
		}
		return items;
	}

	it("accumulates one in-flight item per block and finishes tools by id", () => {
		const bridge = makeBridge();
		feed(bridge, { type: "thinking_delta", contentIndex: 0, delta: "let me " });
		feed(bridge, { type: "thinking_delta", contentIndex: 0, delta: "think" });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "answer " });
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "here" });
		feed(bridge, { type: "toolcall_start", contentIndex: 2, id: "call-7", toolName: "read" });
		feed(bridge, {
			type: "toolcall_end",
			contentIndex: 2,
			toolCall: { name: "read", arguments: { path: "a.ts" }, id: "call-7" },
		});
		bridge.flushEvents();

		const items = tailFile(bridge.eventsPath);
		assert.equal(items.length, 3);
		assert.deepEqual([items[0]?.kind, items[0]?.text], ["thinking", "let me think"]);
		assert.deepEqual([items[1]?.kind, items[1]?.text], ["text", "answer here"]);
		assert.equal(items[2]?.kind, "tool");
		assert.equal(items[2]?.toolName, "read");
		assert.equal(items[2]?.open, false, "tool_end matched by toolCallId finishes the row");
	});

	it("ignores unknown kinds and a torn trailing line", () => {
		const bridge = makeBridge();
		feed(bridge, { type: "text_delta", contentIndex: 0, delta: "kept" });
		bridge.flushEvents();
		fs.appendFileSync(bridge.eventsPath, '{"v":1,"seq":99,"kind":"future_kind","text":"x"}\n');
		fs.appendFileSync(bridge.eventsPath, '{"v":1,"seq":100,"kind":"text","blockId":"text-0","text":"tor');
		const items = tailFile(bridge.eventsPath);
		assert.equal(items.length, 1, "unknown kind ignored, torn line ignored");
		assert.equal(items[0]?.text, "kept");
	});
});
