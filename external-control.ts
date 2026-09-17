import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ExternalAgentState = "queued" | "running" | "waiting" | "idle" | "completed" | "failed" | "stopped";

export interface ExternallyControllableAgent {
	readonly agentId: string;
	readonly label: string;
	readonly startedAt: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly persistent?: boolean;
	readonly status: "queued" | "running" | "completed" | "failed" | "stopped";
	readonly awaitingParent?: boolean;
	readonly sessionPath?: string;
	sendMessage(text: string): Promise<boolean>;
	stop(): Promise<void>;
}

export interface ExternalControlMetadata {
	profile: string;
	parentPid: number;
	treeId: string;
	parentAgentId: string;
}

export interface ExternalControlActions {
	steer?: (message: string) => Promise<boolean>;
	stop?: () => Promise<void>;
}

export interface ExternalControlStatus {
	version: 1;
	runtime: "profiled-subagents";
	agentId: string;
	profile: string;
	treeId: string;
	parentAgentId: string;
	label: string;
	state: ExternalAgentState;
	startedAt: number;
	updatedAt: number;
	sessionPath?: string;
	model?: string;
	thinking?: string;
	waitingForParent?: boolean;
}

type SteerRequest = {
	type: "steer";
	id: string;
	message: string;
	ts?: number;
	source?: string;
};

type StopRequest = {
	type: "stop";
	id?: string;
	ts?: number;
	source?: string;
};

function sanitize(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "agent";
}

function runtimeRoot(): string {
	const suffix =
		typeof process.getuid === "function" ? `uid-${process.getuid()}` : `user-${sanitize(os.userInfo().username)}`;
	return path.join(os.tmpdir(), `pi-profiled-subagents-${suffix}`);
}

function mkdirPrivate(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(directory, 0o700);
	} catch {
		// Best effort on filesystems/platforms that do not implement POSIX modes.
	}
}

function atomicJson(filePath: string, value: unknown): void {
	mkdirPrivate(path.dirname(filePath));
	const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function stateOf(agent: ExternallyControllableAgent): ExternalAgentState {
	if (agent.awaitingParent) return "waiting";
	if (agent.status === "completed" && agent.persistent) return "idle";
	return agent.status;
}

/**
 * Tiny file bridge for UIs such as PiTTy. It is not an orchestration layer:
 * it only mirrors state and accepts direct steer/stop commands for this exact
 * resident child. No budgets, deadlines, pause semantics, or scheduling.
 */
export class ExternalControlBridge {
	readonly controlDir: string;
	readonly statusPath: string;
	private readonly inbox: string;
	private readonly acks: string;
	private timer: NodeJS.Timeout | undefined;
	private processing = false;

	constructor(
		private readonly agent: ExternallyControllableAgent,
		private readonly metadata: ExternalControlMetadata,
		private readonly actions: ExternalControlActions = {},
	) {
		const root = runtimeRoot();
		mkdirPrivate(root);
		this.controlDir = fs.mkdtempSync(path.join(root, `${metadata.parentPid}-${sanitize(agent.agentId)}-`), {
			encoding: "utf8",
		});
		try {
			fs.chmodSync(this.controlDir, 0o700);
		} catch {}
		this.statusPath = path.join(this.controlDir, "status.json");
		this.inbox = path.join(this.controlDir, "control", "steer-requests");
		this.acks = path.join(this.controlDir, "control", "acks");
		mkdirPrivate(this.inbox);
		mkdirPrivate(this.acks);
		this.writeStatus();
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), 200);
		this.timer.unref?.();
	}

	refresh(): void {
		this.writeStatus();
	}

	stopPolling(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.writeStatus();
	}

	cleanup(): void {
		this.stopPolling();
		try {
			fs.rmSync(this.controlDir, { recursive: true, force: true });
		} catch {}
	}

	private snapshot(): ExternalControlStatus {
		return {
			version: 1,
			runtime: "profiled-subagents",
			agentId: this.agent.agentId,
			profile: this.metadata.profile,
			treeId: this.metadata.treeId,
			parentAgentId: this.metadata.parentAgentId,
			label: this.agent.label,
			state: stateOf(this.agent),
			startedAt: this.agent.startedAt,
			updatedAt: Date.now(),
			...(this.agent.sessionPath ? { sessionPath: this.agent.sessionPath } : {}),
			...(this.agent.model ? { model: this.agent.model } : {}),
			...(this.agent.thinking ? { thinking: this.agent.thinking } : {}),
			...(this.agent.awaitingParent ? { waitingForParent: true } : {}),
		};
	}

	private writeStatus(): void {
		try {
			atomicJson(this.statusPath, this.snapshot());
		} catch {
			// UI integration is best-effort and must never break an agent run.
		}
	}

	private async tick(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			this.writeStatus();
			await this.consumeStop();
			await this.consumeSteers();
			this.writeStatus();
			const state = stateOf(this.agent);
			if (state === "completed" || state === "failed" || state === "stopped") this.stopPolling();
		} finally {
			this.processing = false;
		}
	}

	private async consumeStop(): Promise<void> {
		const filePath = path.join(this.controlDir, "control", "stop.json");
		const raw = readJson(filePath);
		if (!raw) return;
		try {
			fs.rmSync(filePath, { force: true });
		} catch {}
		const request: StopRequest = {
			type: "stop",
			...(typeof raw.id === "string" ? { id: raw.id } : {}),
		};
		if (raw.type !== "stop") {
			if (request.id)
				atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), {
					id: request.id,
					ok: false,
					error: "invalid stop request",
				});
			return;
		}
		try {
			await (this.actions.stop?.() ?? this.agent.stop());
			if (request.id)
				atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), { id: request.id, ok: true, action: "stop" });
		} catch (error) {
			if (request.id)
				atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), {
					id: request.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
		}
	}

	private async consumeSteers(): Promise<void> {
		let names: string[];
		try {
			names = fs
				.readdirSync(this.inbox)
				.filter((name) => name.endsWith(".json"))
				.sort();
		} catch {
			return;
		}
		for (const name of names) {
			const filePath = path.join(this.inbox, name);
			const raw = readJson(filePath);
			try {
				fs.rmSync(filePath, { force: true });
			} catch {}
			if (raw?.type !== "steer" || typeof raw.id !== "string" || typeof raw.message !== "string" || !raw.message.trim())
				continue;
			const request: SteerRequest = { type: "steer", id: raw.id, message: raw.message.trim() };
			let ok = false;
			let error: string | undefined;
			try {
				ok = await (this.actions.steer?.(request.message) ?? this.agent.sendMessage(request.message));
				if (!ok) error = "child rejected steer message";
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}
			atomicJson(path.join(this.acks, `${sanitize(request.id)}.json`), {
				id: request.id,
				ok,
				action: "steer",
				...(error ? { error } : {}),
			});
		}
	}
}
