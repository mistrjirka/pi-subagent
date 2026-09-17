import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgentProfiles, resolveAgentProfile } from "../profiles.js";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "profiled-subagents-"));
	roots.push(root);
	const agentDir = path.join(root, "global-agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { root, agentDir, cwd };
}

function write(file: string, text: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

describe("agent profile discovery", () => {
	it("loads Markdown profiles, defaults delegation to none, and keeps normal text body", () => {
		const { agentDir, cwd } = fixture();
		write(
			path.join(agentDir, "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the completed change and report findings as normal text.\n",
		);
		const catalog = discoverAgentProfiles(cwd);
		const reviewer = catalog.profiles.get("reviewer");
		assert.ok(reviewer);
		assert.deepEqual(reviewer.allowedSubagents, []);
		assert.equal(reviewer.prompt, "Review the completed change and report findings as normal text.");
	});

	it("discovers global profiles installed as symlinks", () => {
		const { root, agentDir, cwd } = fixture();
		const source = path.join(root, "generated", "implementer.md");
		write(source, "---\nname: implementer\nallowed_subagents: [explore]\n---\n\nlinked profile\n");
		fs.symlinkSync(source, path.join(agentDir, "agents", "implementer.md"));

		const profile = discoverAgentProfiles(cwd).profiles.get("implementer");
		assert.ok(profile);
		assert.equal(profile.prompt, "linked profile");
		assert.deepEqual(profile.allowedSubagents, ["explore"]);
	});

	it("ignores broken profile symlinks without hiding valid profiles", () => {
		const { root, agentDir, cwd } = fixture();
		write(path.join(agentDir, "agents", "explore.md"), "---\nname: explore\n---\n\nvalid\n");
		fs.symlinkSync(path.join(root, "missing.md"), path.join(agentDir, "agents", "broken.md"));

		const catalog = discoverAgentProfiles(cwd);
		assert.equal(catalog.profiles.get("explore")?.prompt, "valid");
		assert.equal(catalog.profiles.has("broken"), false);
	});

	it("project profiles override global profiles by exact agent name", () => {
		const { agentDir, cwd } = fixture();
		write(path.join(agentDir, "agents", "implementer.md"), "---\nname: implementer\n---\n\nglobal\n");
		write(
			path.join(cwd, ".pi", "agents", "implementer.md"),
			"---\nname: implementer\nallowed_subagents: [explore]\n---\n\nproject\n",
		);
		const profile = discoverAgentProfiles(cwd).profiles.get("implementer");
		assert.equal(profile?.prompt, "project");
		assert.deepEqual(profile?.allowedSubagents, ["explore"]);
	});

	it("settings choose model/thinking without putting them in agent_spawn", () => {
		const { agentDir, cwd } = fixture();
		write(
			path.join(agentDir, "agents", "implementer.md"),
			"---\nname: implementer\nmodel: profile/model\nthinking: low\n---\n\nImplement only.\n",
		);
		write(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				subagentProfiles: {
					defaults: { background: false },
					agents: { implementer: { model: "global/model", thinking: "medium", background: true } },
				},
			}),
		);
		write(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ subagentProfiles: { agents: { implementer: { thinking: "high" } } } }),
		);
		const profile = discoverAgentProfiles(cwd).profiles.get("implementer");
		assert.ok(profile);
		const resolved = resolveAgentProfile(profile, cwd);
		assert.equal(resolved.resolvedModel, "global/model");
		assert.equal(resolved.resolvedThinking, "high");
		assert.equal(resolved.resolvedBackground, true);
	});

	it("parses a background default from profile frontmatter", () => {
		const { agentDir, cwd } = fixture();
		write(path.join(agentDir, "agents", "explore.md"), "---\nname: explore\nbackground: true\n---\n\nExplore.\n");
		const profile = discoverAgentProfiles(cwd).profiles.get("explore");
		assert.ok(profile);
		assert.equal(profile.background, true);
		assert.equal(resolveAgentProfile(profile, cwd).resolvedBackground, true);
	});

	it("malformed allowed_subagents does not grant delegation", () => {
		const { agentDir, cwd } = fixture();
		write(path.join(agentDir, "agents", "bad.md"), "---\nname: bad\nallowed_subagents: explore\n---\n\nbody\n");
		const catalog = discoverAgentProfiles(cwd);
		assert.equal(catalog.profiles.has("bad"), false);
		assert.ok(catalog.warnings.some((warning) => warning.includes("allowed_subagents")));
	});
});
