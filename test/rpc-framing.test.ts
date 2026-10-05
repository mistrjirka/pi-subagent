import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonlFramer } from "../rpc-framing.js";

describe("RPC framing", () => {
	it("rejects one oversize frame and preserves subsequent frames in the same chunk", () => {
		const lines: string[] = [];
		const errors: Error[] = [];
		const framer = new JsonlFramer(
			(line) => lines.push(line),
			(error) => errors.push(error),
			16,
		);
		framer.write(Buffer.from("x".repeat(30) + '\n{"ok":true}\n'));
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /exceeds 16/);
		assert.deepEqual(lines, ['{"ok":true}']);
	});
	it("discards an oversized frame through its newline across chunks", () => {
		const lines: string[] = [];
		const errors: Error[] = [];
		const framer = new JsonlFramer(
			(line) => lines.push(line),
			(error) => errors.push(error),
			8,
		);
		framer.write(Buffer.from("12345678"));
		framer.write(Buffer.from("9tail"));
		framer.write(Buffer.from("more\nnext\n"));
		assert.equal(errors.length, 1);
		assert.deepEqual(lines, ["next"]);
	});
	it("handles split UTF-8 and many short frames without a combined-buffer overflow", () => {
		const lines: string[] = [];
		const framer = new JsonlFramer(
			(line) => lines.push(line),
			() => assert.fail("Unexpected overflow"),
			8,
		);
		const bytes = Buffer.from("ž\none\ntwo\nthree\n");
		framer.write(bytes.subarray(0, 1));
		framer.write(bytes.subarray(1));
		assert.deepEqual(lines, ["ž", "one", "two", "three"]);
	});
});
