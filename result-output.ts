/** Bounded parent results with lossless, on-demand evidence. */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_RESULT_CHARS = 8_000;
const saved = new Map<string, string>();

export function resultPreview(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	const marker = "\n[… omitted …]\n";
	const head = Math.floor((MAX_RESULT_CHARS - marker.length) / 2);
	return text.slice(0, head) + marker + text.slice(-(MAX_RESULT_CHARS - marker.length - head));
}

export function resultOverflowMarker(agentId: string, text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return "";
	const key = createHash("sha256").update(agentId).update("\0").update(text).digest("hex");
	let file = saved.get(key);
	if (!file) {
		try {
			file = join(mkdtempSync(join(tmpdir(), "pi-subagent-result-")), "result.txt");
			writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
			saved.set(key, file);
			if (saved.size > 256) saved.delete(saved.keys().next().value ?? "");
		} catch {
			return "\n\n[Result truncated; full output remains in the child session.]";
		}
	}
	return `\n\n[Result truncated; full output: ${file}]`;
}
