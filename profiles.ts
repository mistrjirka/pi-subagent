import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentProfile {
	name: string;
	description?: string;
	prompt: string;
	allowedSubagents: string[];
	model?: string;
	thinking?: string;
	/** Root-session default only; nested delegation is always foreground. */
	background?: boolean;
	sourcePath: string;
}

interface AgentRuntimeOverride {
	model?: string;
	thinking?: string;
	/** Root-session default only; nested delegation is always foreground. */
	background?: boolean;
}

interface SubagentProfileSettings {
	defaults?: AgentRuntimeOverride;
	agents?: Record<string, AgentRuntimeOverride>;
}

export interface ResolvedAgentProfile extends AgentProfile {
	resolvedModel?: string;
	resolvedThinking?: string;
	resolvedBackground?: boolean;
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

function booleanField(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
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
	const background = booleanField(frontmatter.background);
	if (frontmatter.background !== undefined && background === undefined) {
		throw new Error(`${filePath}: background must be true or false`);
	}
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
		...(background !== undefined ? { background } : {}),
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

/** Discover global agents first, then let project .pi/agents override by exact name. */
export function discoverAgentProfiles(cwd: string): ProfileCatalog {
	const globalScope = loadScope(path.join(agentDir(), "agents"));
	const projectScope = loadScope(path.join(cwd, ".pi", "agents"));
	const profiles = new Map<string, AgentProfile>();
	for (const profile of globalScope.profiles) profiles.set(profile.name, profile);
	for (const profile of projectScope.profiles) profiles.set(profile.name, profile);
	return { profiles, warnings: [...globalScope.warnings, ...projectScope.warnings] };
}

function runtimeOverride(value: unknown): AgentRuntimeOverride | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const model = stringField(raw.model);
	const thinking = stringField(raw.thinking);
	const background = booleanField(raw.background);
	if (thinking && !THINKING_LEVELS.has(thinking)) return undefined;
	if (raw.background !== undefined && background === undefined) return undefined;
	return {
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(background !== undefined ? { background } : {}),
	};
}

function readProfileSettings(filePath: string): SubagentProfileSettings {
	try {
		const root = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		if (!root || typeof root !== "object" || Array.isArray(root)) return {};
		const namespace = (root as Record<string, unknown>).subagentProfiles;
		if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) return {};
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
		return {
			...(defaults ? { defaults } : {}),
			...(Object.keys(agents).length ? { agents } : {}),
		};
	} catch {
		return {};
	}
}

/**
 * Resolve model/thinking without exposing them on agent_spawn.
 * Agent-specific settings win; profile frontmatter is next; shared defaults
 * only fill fields the profile did not pin. Project settings override global.
 */
export function resolveAgentProfile(profile: AgentProfile, cwd: string): ResolvedAgentProfile {
	const globalSettings = readProfileSettings(path.join(agentDir(), "settings.json"));
	const projectSettings = readProfileSettings(path.join(cwd, ".pi", "settings.json"));
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
	const resolvedBackground =
		projectAgent?.background ??
		globalAgent?.background ??
		profile.background ??
		projectSettings.defaults?.background ??
		globalSettings.defaults?.background;
	return {
		...profile,
		...(resolvedModel ? { resolvedModel } : {}),
		...(resolvedThinking ? { resolvedThinking } : {}),
		...(resolvedBackground !== undefined ? { resolvedBackground } : {}),
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
