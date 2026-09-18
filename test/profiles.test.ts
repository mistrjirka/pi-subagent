import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BUILTIN_CORE_PROFILE_NAMES,
	BUILTIN_EXTENDED_PROFILE_NAMES,
	discoverAgentProfiles,
	type ProfileCatalog,
	resolveAgentProfile,
} from "../profiles.js";

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
			JSON.stringify({ subagentProfiles: { agents: { implementer: { model: "global/model", thinking: "medium" } } } }),
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
	});

	it("malformed allowed_subagents does not grant delegation", () => {
		const { agentDir, cwd } = fixture();
		write(path.join(agentDir, "agents", "bad.md"), "---\nname: bad\nallowed_subagents: explore\n---\n\nbody\n");
		const catalog = discoverAgentProfiles(cwd);
		assert.equal(catalog.profiles.has("bad"), false);
		assert.ok(catalog.warnings.some((warning) => warning.includes("allowed_subagents")));
	});
});

describe("bundled agent profiles", () => {
	const DISALLOWED = [
		/javaScript/i,
		/typeScript/i,
		/\bnode\b/i,
		/\bnpm\b/i,
		/\bpnpm\b/i,
		/\btsx\b/i,
		/\bzod\b/i,
		/\bas\s+any\b/i,
		/ripgrep/i,
		/ast-grep/i,
		/codegraph/i,
		/semble/i,
	];

	const CORE_DELEGATION: Record<string, string[]> = {
		explore: [],
		implementer: ["explore"],
		"debugging-duck": ["explore"],
	};

	const ALL_BUNDLED_NAMES = [...BUILTIN_CORE_PROFILE_NAMES, ...BUILTIN_EXTENDED_PROFILE_NAMES];

	function settings(file: string, builtinAgents: unknown) {
		write(file, JSON.stringify({ subagentProfiles: { builtinAgents } }));
	}

	/**
	 * Shared strict contract for every bundled profile: present in the
	 * catalog, loaded from the bundle, carrying a nonempty portable prompt
	 * with no pinned model/thinking, and exactly the expected delegation.
	 */
	function expectPortable(catalog: ProfileCatalog, name: string, allowedSubagents: string[]) {
		const profile = catalog.profiles.get(name);
		assert.ok(profile, `missing bundled profile ${name}`);
		assert.ok(profile.prompt.trim().length > 0, `${name} has an empty prompt`);
		assert.ok(
			profile.sourcePath.includes(`builtin-agents${path.sep}`),
			`${name} should load from the bundle, got ${profile.sourcePath}`,
		);
		assert.equal(profile.model, undefined, `${name} must not hard-code a model`);
		assert.equal(profile.thinking, undefined, `${name} must not hard-code a thinking level`);
		assert.deepEqual(profile.allowedSubagents, allowedSubagents, `${name} has unexpected delegation`);
		for (const pattern of DISALLOWED) {
			assert.ok(!pattern.test(profile.prompt), `${name} prompt matches disallowed ${pattern}`);
		}
	}

	it("loads exactly the default trio with delegation edges and portable prompts", () => {
		const { cwd } = fixture();
		assert.equal(BUILTIN_CORE_PROFILE_NAMES.length, 3);
		const catalog = discoverAgentProfiles(cwd);
		assert.deepEqual(new Set(catalog.profiles.keys()), new Set(BUILTIN_CORE_PROFILE_NAMES));
		for (const name of BUILTIN_CORE_PROFILE_NAMES) {
			expectPortable(catalog, name, CORE_DELEGATION[name] ?? []);
		}
	});

	it('"none" suppresses only the bundle: custom files remain, and emptiness needs no bundle', () => {
		const { agentDir, cwd } = fixture();
		settings(path.join(agentDir, "settings.json"), "none");
		write(path.join(agentDir, "agents", "reviewer.md"), "---\nname: reviewer\n---\n\nCustom review.\n");
		write(path.join(cwd, ".pi", "agents", "mine.md"), "---\nname: mine\n---\n\nProject custom.\n");
		const catalog = discoverAgentProfiles(cwd);
		assert.deepEqual(new Set(catalog.profiles.keys()), new Set(["reviewer", "mine"]));

		const empty = fixture();
		settings(path.join(empty.agentDir, "settings.json"), "none");
		assert.equal(discoverAgentProfiles(empty.cwd).profiles.size, 0);
	});

	it('"all" loads all nine portable profiles and extended profiles never delegate', () => {
		const { agentDir, cwd } = fixture();
		assert.equal(BUILTIN_CORE_PROFILE_NAMES.length, 3);
		assert.equal(BUILTIN_EXTENDED_PROFILE_NAMES.length, 6);
		settings(path.join(agentDir, "settings.json"), "all");
		const catalog = discoverAgentProfiles(cwd);
		assert.deepEqual(new Set(catalog.profiles.keys()), new Set(ALL_BUNDLED_NAMES));
		for (const name of BUILTIN_CORE_PROFILE_NAMES) {
			expectPortable(catalog, name, CORE_DELEGATION[name] ?? []);
		}
		for (const name of BUILTIN_EXTENDED_PROFILE_NAMES) {
			expectPortable(catalog, name, []);
		}
	});

	it('project "all" overrides global "none"', () => {
		const { agentDir, cwd } = fixture();
		settings(path.join(agentDir, "settings.json"), "none");
		settings(path.join(cwd, ".pi", "settings.json"), "all");
		const catalog = discoverAgentProfiles(cwd);
		assert.deepEqual(new Set(catalog.profiles.keys()), new Set(ALL_BUNDLED_NAMES));
	});

	it('project "none" opts out of the bundle even when global selects more', () => {
		for (const globalMode of [undefined, "default", "all"] as const) {
			const { agentDir, cwd } = fixture();
			if (globalMode !== undefined) settings(path.join(agentDir, "settings.json"), globalMode);
			settings(path.join(cwd, ".pi", "settings.json"), "none");
			write(path.join(cwd, ".pi", "agents", "mine.md"), "---\nname: mine\n---\n\nProject custom.\n");
			const catalog = discoverAgentProfiles(cwd);
			assert.deepEqual(
				new Set(catalog.profiles.keys()),
				new Set(["mine"]),
				`global ${globalMode ?? "(unset)"} + project "none" should leave a custom-only catalog`,
			);
		}
	});

	it("global and project custom profiles override a same-name built-in", () => {
		const { agentDir, cwd } = fixture();
		write(
			path.join(agentDir, "agents", "explore.md"),
			"---\nname: explore\nallowed_subagents: [implementer]\n---\n\nGlobal custom explore.\n",
		);
		const global = discoverAgentProfiles(cwd).profiles.get("explore");
		assert.equal(global?.prompt, "Global custom explore.");
		assert.deepEqual(global?.allowedSubagents, ["implementer"]);
		assert.ok(!global?.sourcePath.includes("builtin-agents"));
		// The rest of the bundle still loads around the override.
		assert.ok(discoverAgentProfiles(cwd).profiles.has("implementer"));
		assert.ok(discoverAgentProfiles(cwd).profiles.has("debugging-duck"));

		write(path.join(cwd, ".pi", "agents", "explore.md"), "---\nname: explore\n---\n\nProject custom explore.\n");
		const project = discoverAgentProfiles(cwd).profiles.get("explore");
		assert.equal(project?.prompt, "Project custom explore.");
		assert.deepEqual(project?.allowedSubagents, []);
	});

	it("invalid builtinAgents values are ignored with a warning naming the settings file", () => {
		const { agentDir, cwd } = fixture();
		const globalPath = path.join(agentDir, "settings.json");
		settings(globalPath, "sometimes");
		const catalog = discoverAgentProfiles(cwd);
		assert.deepEqual(new Set(catalog.profiles.keys()), new Set(BUILTIN_CORE_PROFILE_NAMES));
		assert.ok(
			catalog.warnings.some(
				(warning) =>
					warning.includes(globalPath) &&
					warning.includes("builtinAgents") &&
					warning.includes("sometimes") &&
					warning.includes("ignoring invalid value") &&
					!warning.includes("falling back"),
			),
			`expected a neutral invalid-value warning naming ${globalPath}, got: ${JSON.stringify(catalog.warnings)}`,
		);

		// Invalid at both scopes still yields default, with a warning per file.
		const both = fixture();
		const bothGlobal = path.join(both.agentDir, "settings.json");
		const bothProject = path.join(both.cwd, ".pi", "settings.json");
		settings(bothGlobal, "sometimes");
		settings(bothProject, "never");
		const bothCatalog = discoverAgentProfiles(both.cwd);
		assert.deepEqual(new Set(bothCatalog.profiles.keys()), new Set(BUILTIN_CORE_PROFILE_NAMES));
		assert.ok(
			bothCatalog.warnings.some((warning) => warning.includes(bothGlobal) && warning.includes("sometimes")),
			`expected a global warning, got: ${JSON.stringify(bothCatalog.warnings)}`,
		);
		assert.ok(
			bothCatalog.warnings.some((warning) => warning.includes(bothProject) && warning.includes("never")),
			`expected a project warning, got: ${JSON.stringify(bothCatalog.warnings)}`,
		);
	});

	it("an invalid project value is ignored so a valid global setting stays effective", () => {
		const { agentDir, cwd } = fixture();
		const projectPath = path.join(cwd, ".pi", "settings.json");
		settings(path.join(agentDir, "settings.json"), "all");
		settings(projectPath, 42);
		const catalog = discoverAgentProfiles(cwd);
		assert.deepEqual(new Set(catalog.profiles.keys()), new Set(ALL_BUNDLED_NAMES));
		const warning = catalog.warnings.find((candidate) => candidate.includes(projectPath) && candidate.includes("42"));
		assert.ok(
			warning,
			`expected an invalid-value warning naming ${projectPath}, got: ${JSON.stringify(catalog.warnings)}`,
		);
		assert.ok(warning.includes("ignoring invalid value"), `warning should say the value is ignored, got: ${warning}`);
		assert.ok(!warning.includes("falling back"), `warning must not claim a default fallback, got: ${warning}`);
	});

	it("package manifest includes the built-in profile directory", () => {
		const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
		const manifest: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		const files: unknown =
			typeof manifest === "object" && manifest !== null && "files" in manifest ? manifest.files : undefined;
		assert.ok(
			Array.isArray(files) && files.includes("builtin-agents/**/*.md"),
			"files must pin builtin-agents/**/*.md",
		);
		for (const name of [...BUILTIN_CORE_PROFILE_NAMES, ...BUILTIN_EXTENDED_PROFILE_NAMES]) {
			const matches = [
				path.join(packageRoot, "builtin-agents", "core", `${name}.md`),
				path.join(packageRoot, "builtin-agents", "extended", `${name}.md`),
			].filter((file) => fs.existsSync(file));
			assert.equal(matches.length, 1, `exactly one bundled file should exist for ${name}`);
		}
	});
});
