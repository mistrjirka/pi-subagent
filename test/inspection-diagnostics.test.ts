import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { inspectContextDiagnostics } from "../inspection-diagnostics.js";

it("exposes hidden context provenance on demand without content or reasoning", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-diagnostics-"));
	try {
		const path = join(dir, "session.jsonl");
		writeFileSync(
			path,
			[
				{
					type: "message",
					id: "s",
					message: { role: "system", sections: { rules: "private-rule" }, toolsAdded: [{ name: "read" }] },
				},
				{ type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "private-task" }] } },
				{ type: "custom_message", id: "c", customType: "eigen-recall", display: false, content: "private-memory" },
				{
					type: "message",
					id: "a",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "private-thought", signature: "secret" }],
					},
				},
			]
				.map((value) => JSON.stringify(value))
				.join("\n") + "\n",
		);
		const result = inspectContextDiagnostics(path);
		assert.match(result, /eigen-recall; display=false/);
		assert.match(result, /rules=12/);
		assert.match(result, /Registered tool schemas: 1/);
		assert.doesNotMatch(result, /private-|secret/);
		assert.ok(result.length <= 2200);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
