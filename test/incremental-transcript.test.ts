import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { IncrementalTranscriptCursor, type TranscriptReadableAgent } from "../transcript.js";

type Entry = Record<string, unknown> & { id: string };

function message(id: string, text: string): Entry {
	return {
		type: "message",
		id,
		timestamp: Date.now(),
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function fakeAgent(entries: Entry[], calls: Array<string | undefined> = []): TranscriptReadableAgent {
	return {
		getEntries: async (since?: string) => {
			calls.push(since);
			const index = since ? entries.findIndex((entry) => entry.id === since) : -1;
			if (since && index < 0) throw new Error(`unknown cursor ${since}`);
			return {
				entries: entries.slice(index + 1),
				leafId: entries.at(-1)?.id ?? null,
			};
		},
	};
}

describe("IncrementalTranscriptCursor", () => {
	it("pages unread messages without repeating or skipping them", async () => {
		const entries = [message("m1", "one"), message("m2", "two"), message("m3", "three")];
		const cursor = new IncrementalTranscriptCursor();
		const agent = fakeAgent(entries);

		const first = await cursor.read(agent, { maxMessages: 2, maxChars: 20_000 });
		assert.match(first.text, /one/);
		assert.match(first.text, /two/);
		assert.doesNotMatch(first.text, /three/);
		assert.equal(first.returnedMessages, 2);
		assert.equal(first.remainingMessages, 1);

		const second = await cursor.read(agent, { maxMessages: 2, maxChars: 20_000 });
		assert.doesNotMatch(second.text, /one|two/);
		assert.match(second.text, /three/);
		assert.equal(second.returnedMessages, 1);
		assert.equal(second.remainingMessages, 0);

		const third = await cursor.read(agent, { maxMessages: 2, maxChars: 20_000 });
		assert.equal(third.text, "[no new transcript messages]");
		assert.equal(third.returnedMessages, 0);

		entries.push(message("m4", "four"));
		const fourth = await cursor.read(agent, { maxMessages: 2, maxChars: 20_000 });
		assert.equal(fourth.returnedMessages, 1);
		assert.match(fourth.text, /four/);
		assert.doesNotMatch(fourth.text, /one|two|three/);
	});

	it("serializes concurrent reads so parallel wait/inspect calls do not duplicate a page", async () => {
		const entries = [message("m1", "one"), message("m2", "two"), message("m3", "three"), message("m4", "four")];
		const calls: Array<string | undefined> = [];
		const cursor = new IncrementalTranscriptCursor();
		const agent = fakeAgent(entries, calls);

		const [first, second] = await Promise.all([
			cursor.read(agent, { maxMessages: 2, maxChars: 20_000 }),
			cursor.read(agent, { maxMessages: 2, maxChars: 20_000 }),
		]);

		assert.match(first.text, /one/);
		assert.match(first.text, /two/);
		assert.doesNotMatch(first.text, /three|four/);
		assert.match(second.text, /three/);
		assert.match(second.text, /four/);
		assert.doesNotMatch(second.text, /one|two/);
		assert.deepEqual(calls, [undefined, "m2"]);
	});

	it("advances through non-message session entries after the last unread message", async () => {
		const entries: Entry[] = [message("m1", "one"), { type: "compaction", id: "c1", summary: "summary" }];
		const calls: Array<string | undefined> = [];
		const cursor = new IncrementalTranscriptCursor();
		const agent = fakeAgent(entries, calls);

		const first = await cursor.read(agent, { maxMessages: 10, maxChars: 20_000 });
		assert.match(first.text, /one/);
		const empty = await cursor.read(agent, { maxMessages: 10, maxChars: 20_000 });
		assert.equal(empty.text, "[no new transcript messages]");
		assert.deepEqual(calls, [undefined, "c1"]);

		entries.push(message("m2", "two"));
		const next = await cursor.read(agent, { maxMessages: 10, maxChars: 20_000 });
		assert.match(next.text, /two/);
		assert.doesNotMatch(next.text, /one/);
	});

	it("does not advance the cursor when get_entries fails", async () => {
		let fail = true;
		const calls: Array<string | undefined> = [];
		const entries = [message("m1", "one")];
		const agent: TranscriptReadableAgent = {
			getEntries: async (since?: string) => {
				calls.push(since);
				if (fail) {
					fail = false;
					throw new Error("temporary RPC failure");
				}
				return { entries, leafId: "m1" };
			},
		};
		const cursor = new IncrementalTranscriptCursor();

		const failed = await cursor.read(agent);
		assert.equal(failed.source, "none");
		assert.match(failed.text, /temporary RPC failure/);

		const retried = await cursor.read(agent);
		assert.equal(retried.source, "rpc");
		assert.match(retried.text, /one/);
		assert.deepEqual(calls, [undefined, undefined]);
	});
});

describe("recent supervision and older-history backfill", () => {
	it("does not repeat messages from inspect in a later recent wait", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-backfill-"));
		try {
			const path = join(dir, "session.jsonl");
			const entries = [message("e1", "older message"), message("e2", "latest message")];
			writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			const cursor = new IncrementalTranscriptCursor();
			const agent: TranscriptReadableAgent = { sessionPath: path };
			const inspected = await cursor.read(agent);
			assert.equal(inspected.returnedMessages, 2);
			const recent = await cursor.readRecent(agent);
			assert.equal(recent.returnedMessages, 0);
			assert.doesNotMatch(recent.text, /older message|latest message/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("shows newest progress first, then lets inspect read older entries without repeats", async () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-recent-"));
		try {
			const path = join(dir, "session.jsonl");
			const entries = Array.from({ length: 20 }, (_, index) =>
				message("e" + index, "step " + index),
			);
			writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			const cursor = new IncrementalTranscriptCursor();
			const agent: TranscriptReadableAgent = { sessionPath: path };

			const first = await cursor.readRecent(agent, { maxMessages: 3, maxChars: 3000, perMessageChars: 250 });
			assert.equal(first.returnedMessages, 3);
			assert.ok(first.text.indexOf("step 19") < first.text.indexOf("step 18"));
			assert.ok(first.text.indexOf("step 18") < first.text.indexOf("step 17"));
			assert.doesNotMatch(first.text, /step 0/);

			const none = await cursor.readRecent(agent, { maxMessages: 3 });
			assert.equal(none.returnedMessages, 0);
			assert.equal(none.text, "[no new recent transcript messages]");

			const older = await cursor.read(agent, { maxMessages: 20, maxChars: 15000 });
			assert.match(older.text, /step 0/);
			assert.match(older.text, /step 16/);
			assert.doesNotMatch(older.text, /step 17|step 18|step 19/);

			const newer = message("e20", "step 20");
			appendFileSync(path, JSON.stringify(newer) + "\n");
			const update = await cursor.readRecent(agent, { maxMessages: 3 });
			assert.equal(update.returnedMessages, 1);
			assert.match(update.text, /step 20/);
			assert.doesNotMatch(update.text, /step 19/);

			const after = await cursor.read(agent, { maxMessages: 10 });
			assert.equal(after.returnedMessages, 0);
			assert.doesNotMatch(after.text, /step 20/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
