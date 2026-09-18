import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentProfile {
	name: string;
	description?: string;
	prompt: string;
	allowedSubagents: string[];
	model?: string;
	thinking?: string;
	sourcePath: string;
}

interface AgentRuntimeOverride {
	model?: string;
	thinking?: string;
}

export type BuiltinAgentsMode = "default" | "none" | "all";

/** Bundled profiles loaded when `builtinAgents` is omitted or `"default"`. */
export const BUILTIN_CORE_PROFILE_NAMES = ["explore", "implementer", "debugging-duck"] as const;

/** Additional bundled profiles loaded only when `builtinAgents` is `"all"`. */
export const BUILTIN_EXTENDED_PROFILE_NAMES = [
	"feasibility",
	"implementation-review",
	"impl-check-behavior",
	"impl-check-contracts",
	"impl-check-design",
	"impl-check-runtime",
] as const;

const BUILTIN_MODES: ReadonlySet<string> = new Set(["default", "none", "all"]);

function isBuiltinAgentsMode(value: unknown): value is BuiltinAgentsMode {
	return typeof value === "string" && BUILTIN_MODES.has(value);
}

function packageDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

interface SubagentProfileSettings {
	defaults?: AgentRuntimeOverride;
	agents?: Record<string, AgentRuntimeOverride>;
	builtinAgents?: BuiltinAgentsMode;
}

/** One settings file plus a warning when its `builtinAgents` value is invalid. */
interface SettingsFile {
	settings: SubagentProfileSettings;
	builtinAgentsWarning?: string;
}

export interface ResolvedAgentProfile extends AgentProfile {
	resolvedModel?: string;
	resolvedThinking?: string;
}

export interface ProfileCatalog {
	profiles: Map<string, AgentProfile>;
	warnings: string[];
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim()) return undefined;
		const name = item.trim();
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

function parseFrontmatter(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
	const text = fs.readFileSync(filePath, "utf8");
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
		return { frontmatter: {}, body: text.trim() };
	}
	const normalized = text.replaceAll("\r\n", "\n");
	const end = normalized.indexOf("\n---\n", 4);
	if (end === -1) throw new Error(`${filePath}: unclosed YAML frontmatter`);
	const raw = normalized.slice(4, end);
	const parsed = parseYaml(raw);
	if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
		throw new Error(`${filePath}: YAML frontmatter must be a mapping`);
	}
	return {
		frontmatter: (parsed ?? {}) as Record<string, unknown>,
		body: normalized.slice(end + 5).trim(),
	};
}

function parseProfile(filePath: string): AgentProfile {
	const { frontmatter, body } = parseFrontmatter(filePath);
	const fallbackName = path.basename(filePath, path.extname(filePath));
	const name = stringField(frontmatter.name) ?? fallbackName;
	if (!name) throw new Error(`${filePath}: agent name is empty`);
	const description = stringField(frontmatter.description);
	const allowedSubagents = booleanArray(frontmatter.allowed_subagents) ?? [];
	if (frontmatter.allowed_subagents !== undefined && booleanArray(frontmatter.allowed_subagents) === undefined) {
		throw new Error(`${filePath}: allowed_subagents must be an array of non-empty agent names`);
	}
	const model = stringField(frontmatter.model);
	const thinking = stringField(frontmatter.thinking);
	if (thinking && !THINKING_LEVELS.has(thinking)) {
		throw new Error(`${filePath}: invalid thinking level ${JSON.stringify(thinking)}`);
	}
	return {
		name,
		...(description ? { description } : {}),
		prompt: body,
		allowedSubagents,
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		sourcePath: filePath,
	};
}

function markdownFiles(directory: string): string[] {
	try {
		return fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => {
				if (!entry.name.toLowerCase().endsWith(".md")) return false;
				if (entry.isFile()) return true;
				if (!entry.isSymbolicLink()) return false;
				try {
					return fs.statSync(path.join(directory, entry.name)).isFile();
				} catch {
					return false;
				}
			})
			.map((entry) => path.join(directory, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function loadScope(directory: string): { profiles: AgentProfile[]; warnings: string[] } {
	const profiles: AgentProfile[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	for (const filePath of markdownFiles(directory)) {
		try {
			const profile = parseProfile(filePath);
			if (seen.has(profile.name)) {
				warnings.push(`${directory}: duplicate agent name ${JSON.stringify(profile.name)}; ignoring ${filePath}`);
				continue;
			}
			seen.add(profile.name);
			profiles.push(profile);
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { profiles, warnings };
}

/**
 * Pick the bundled-profile mode from the two settings scopes. Project
 * `builtinAgents` overrides global `builtinAgents`; an omitted or invalid
 * value in both scopes falls back to `"default"`. Invalid values are kept
 * as warnings so the ignore is visible instead of silent.
 */
function selectBuiltinAgentsMode(
	globalFile: SettingsFile,
	projectFile: SettingsFile,
): { mode: BuiltinAgentsMode; warnings: string[] } {
	const warnings: string[] = [];
	if (globalFile.builtinAgentsWarning) warnings.push(globalFile.builtinAgentsWarning);
	if (projectFile.builtinAgentsWarning) warnings.push(projectFile.builtinAgentsWarning);
	return {
		mode: projectFile.settings.builtinAgents ?? globalFile.settings.builtinAgents ?? "default",
		warnings,
	};
}

function readSettingsFiles(cwd: string): { globalFile: SettingsFile; projectFile: SettingsFile } {
	return {
		globalFile: readSettingsFile(path.join(agentDir(), "settings.json")),
		projectFile: readSettingsFile(path.join(cwd, ".pi", "settings.json")),
	};
}

/**
 * Resolve the bundled-profile mode for a project. Project `builtinAgents`
 * overrides global `builtinAgents`; an omitted or invalid value in both scopes
 * falls back to `"default"`.
 */
export function resolveBuiltinAgentsMode(cwd: string): BuiltinAgentsMode {
	const { globalFile, projectFile } = readSettingsFiles(cwd);
	return selectBuiltinAgentsMode(globalFile, projectFile).mode;
}

function loadBuiltinProfiles(mode: BuiltinAgentsMode): { profiles: AgentProfile[]; warnings: string[] } {
	if (mode === "none") return { profiles: [], warnings: [] };
	const core = loadScope(path.join(packageDir(), "builtin-agents", "core"));
	if (mode === "default") return core;
	const extended = loadScope(path.join(packageDir(), "builtin-agents", "extended"));
	return { profiles: [...core.profiles, ...extended.profiles], warnings: [...core.warnings, ...extended.warnings] };
}

/**
 * Discover bundled profiles first, then global user profiles, then project
 * user profiles. A later scope overrides an earlier one by exact agent name,
 * so a custom profile at either user location wins over a same-name bundled
 * profile, and a project custom profile wins over both. `"none"` suppresses
 * only bundled files; user profiles always load.
 */
export function discoverAgentProfiles(cwd: string): ProfileCatalog {
	const { globalFile, projectFile } = readSettingsFiles(cwd);
	const selection = selectBuiltinAgentsMode(globalFile, projectFile);
	const builtinScope = loadBuiltinProfiles(selection.mode);
	const globalScope = loadScope(path.join(agentDir(), "agents"));
	const projectScope = loadScope(path.join(cwd, ".pi", "agents"));
	const profiles = new Map<string, AgentProfile>();
	for (const profile of builtinScope.profiles) profiles.set(profile.name, profile);
	for (const profile of globalScope.profiles) profiles.set(profile.name, profile);
	for (const profile of projectScope.profiles) profiles.set(profile.name, profile);
	return {
		profiles,
		warnings: [...selection.warnings, ...builtinScope.warnings, ...globalScope.warnings, ...projectScope.warnings],
	};
}

function runtimeOverride(value: unknown): AgentRuntimeOverride | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const model = stringField(raw.model);
	const thinking = stringField(raw.thinking);
	if (thinking && !THINKING_LEVELS.has(thinking)) return undefined;
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

function readSettingsFile(filePath: string): SettingsFile {
	try {
		const root = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		if (!root || typeof root !== "object" || Array.isArray(root)) return { settings: {} };
		const namespace = (root as Record<string, unknown>).subagentProfiles;
		if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) return { settings: {} };
		const raw = namespace as Record<string, unknown>;
		const defaults = runtimeOverride(raw.defaults);
		const agentsRaw = raw.agents;
		const agents: Record<string, AgentRuntimeOverride> = {};
		if (agentsRaw && typeof agentsRaw === "object" && !Array.isArray(agentsRaw)) {
			for (const [name, value] of Object.entries(agentsRaw as Record<string, unknown>)) {
				const parsed = runtimeOverride(value);
				if (parsed) agents[name] = parsed;
			}
		}
		const builtinRaw: unknown = raw.builtinAgents;
		const builtinAgents: BuiltinAgentsMode | undefined = isBuiltinAgentsMode(builtinRaw) ? builtinRaw : undefined;
		const builtinAgentsWarning =
			builtinRaw === undefined || builtinAgents !== undefined
				? undefined
				: `${filePath}: invalid subagentProfiles.builtinAgents ${JSON.stringify(builtinRaw)}; expected "default", "none", or "all" — ignoring invalid value.`;
		return {
			settings: {
				...(defaults ? { defaults } : {}),
				...(Object.keys(agents).length ? { agents } : {}),
				...(builtinAgents ? { builtinAgents } : {}),
			},
			...(builtinAgentsWarning ? { builtinAgentsWarning } : {}),
		};
	} catch {
		return { settings: {} };
	}
}

/**
 * Resolve model/thinking without exposing them on agent_spawn.
 * Agent-specific settings win; profile frontmatter is next; shared defaults
 * only fill fields the profile did not pin. Project settings override global.
 */
export function resolveAgentProfile(profile: AgentProfile, cwd: string): ResolvedAgentProfile {
	const globalSettings = readSettingsFile(path.join(agentDir(), "settings.json")).settings;
	const projectSettings = readSettingsFile(path.join(cwd, ".pi", "settings.json")).settings;
	const globalAgent = globalSettings.agents?.[profile.name];
	const projectAgent = projectSettings.agents?.[profile.name];
	const resolvedModel =
		projectAgent?.model ??
		globalAgent?.model ??
		profile.model ??
		projectSettings.defaults?.model ??
		globalSettings.defaults?.model;
	const resolvedThinking =
		projectAgent?.thinking ??
		globalAgent?.thinking ??
		profile.thinking ??
		projectSettings.defaults?.thinking ??
		globalSettings.defaults?.thinking;
	return {
		...profile,
		...(resolvedModel ? { resolvedModel } : {}),
		...(resolvedThinking ? { resolvedThinking } : {}),
	};
}

export function parseAllowedSubagentsEnv(value: string | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return booleanArray(parsed) ?? [];
	} catch {
		return [];
	}
}

export function formatAvailableProfiles(catalog: ProfileCatalog): string {
	if (catalog.profiles.size === 0) return "none";
	return [...catalog.profiles.values()]
		.map((profile) => (profile.description ? `${profile.name} — ${profile.description}` : profile.name))
		.join("; ");
}
