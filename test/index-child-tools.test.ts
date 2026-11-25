import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

for (const delegates of [false, true]) {
	it(`registers and exposes the actual ${delegates ? "delegating" : "leaf"} child tool contract`, () => {
		const dir = mkdtempSync(join(tmpdir(), "child-tool-contract-"));
		try {
			const script = `
				import register from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
				const tools = [], starts = [];
				let active = ["read", "bash", "session_search", "memory_read", "web_search", "codegraph_search"];
				register({
					on(event, handler) { if(event === "session_start") starts.push(handler); },
					registerTool(tool) { tools.push(tool); active.push(tool.name); },
					registerMessageRenderer() {}, events: { on() {} },
					getActiveTools() { return active; }, setActiveTools(names) { active = names; }
				});
				for (const start of starts) await start();
				console.log(JSON.stringify({ active, names: tools.map(t => t.name), spawnGuidelines: tools.find(t => t.name === "agent_spawn")?.promptGuidelines ?? [] }));
			`;
			const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				encoding: "utf8",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: dir,
					PI_SUBAGENT_AGENT_ID: "child",
					PI_SUBAGENT_PROFILE: "implementer",
					PI_SUBAGENT_ALLOWED_SUBAGENTS: JSON.stringify(delegates ? ["explore"] : []),
					PI_SUBAGENT_TOOL_GROUPS: '["discovery"]',
				},
				timeout: 15_000,
			});
			assert.equal(run.status, 0, run.stderr);
			const result = JSON.parse(run.stdout) as { active: string[]; names: string[]; spawnGuidelines: string[] };
			assert.ok(result.active.includes("read"));
			assert.ok(result.active.includes("memory_read"));
			assert.ok(result.active.includes("codegraph_search"));
			assert.ok(!result.active.includes("web_search"));
			assert.ok(result.names.includes("ask_parent"));
			assert.ok(!result.names.includes("agent_recover"));
			assert.equal(result.names.includes("agent_wait"), delegates);
			assert.equal(result.active.includes("agent_spawn"), delegates);
			assert.ok(!result.spawnGuidelines.join(" ").includes("agent_recover"));
			assert.ok(!result.spawnGuidelines.join(" ").includes("resume_id"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
