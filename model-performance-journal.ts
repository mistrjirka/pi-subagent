/** Durable, content-free measurements from all direct and nested children.
 *  Each response is one bounded append, never a write on a streamed token.
 *  Daily segments avoid read/modify/write races between independent Pi hosts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RequestPerformance } from "./request-performance.js";

const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_DAY_BYTES = 8 * 1024 * 1024;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
let lastPrune: string | undefined;

export function performanceJournalDirectory(): string {
	const base = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
	return path.join(base, "pi-subagent", "model-performance");
}

export function recordSubagentPerformance(
	sample: RequestPerformance,
	now = Date.now(),
	directory = performanceJournalDirectory(),
): void {
	const { provider, modelId, ttftMs, generationMs, outputTokens } = sample;
	if (!provider || !modelId || provider.length > 256 || modelId.length > 1024 ||
		!Number.isFinite(now) || now < 0 || now > 8_640_000_000_000_000 ||
		!Number.isFinite(ttftMs) || ttftMs < 0 ||
		!Number.isFinite(generationMs) || generationMs < 1000 ||
		!Number.isSafeInteger(outputTokens) || outputTokens <= 0) return;
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const day = new Date(now).toISOString().slice(0, 10);
		const pruneKey = directory + "\0" + day;
		if (lastPrune !== pruneKey) {
			lastPrune = pruneKey;
			const oldestDay = new Date(Math.max(0, now - RETENTION_MS)).toISOString().slice(0, 10);
			for (const name of fs.readdirSync(directory)) {
				if (DAY_FILE.test(name) && name.slice(0, 10) < oldestDay) {
					try { fs.unlinkSync(path.join(directory, name)); } catch { /* best effort */ }
				}
			}
		}
		const file = path.join(directory, day + ".jsonl");
		const line = JSON.stringify({ version: 3, timestamp: now, provider, modelId, ttftMs, generationMs, outputTokens }) + "\n";
		const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			const stat = fs.fstatSync(fd);
			if (stat.isFile() && stat.size + Buffer.byteLength(line) <= MAX_DAY_BYTES) fs.writeSync(fd, line);
		} finally { fs.closeSync(fd); }
	} catch { /* Local performance telemetry never changes agent behavior. */ }
}
