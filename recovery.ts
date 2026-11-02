/**
 * Durable, explicit recovery for root-owned persistent subagents.
 *
 * Only the transcript path and non-secret routing metadata are stored here.
 * A recovered worker never runs until agent_spawn receives a fresh prompt.
 * The record is guarded by an exclusive PID lease while its Pi parent lives.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RecoveryRecord {
	version: 1;
	id: string;
	cwd: string;
	branch: string | null;
	profile: string;
	label: string;
	model: string;
	thinking?: string;
	sessionPath: string;
	updatedAt: string;
	ownerPid: number | null;
	status: "active" | "suspended" | "stopped";
}

export interface RecoverySession {
	cwd: string;
	profile: string;
	label: string;
	model: string;
	thinking?: string;
	sessionPath: string;
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function canonical(p: string): string {
	return fs.realpathSync(p);
}

function branchAt(cwd: string): string | null {
	try {
		const name = execFileSync("git", ["branch", "--show-current"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3_000,
		}).trim();
		// Detached HEAD and directories outside Git have no branch identity.
		return name || null;
	} catch {
		return null;
	}
}

function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return true; // fail closed on malformed leases
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM is alive
	}
}

function atomicJson(file: string, object: unknown): void {
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
	let created = false;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(object, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		created = true;
		fs.renameSync(temporary, file);
	} finally {
		if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): RecoveryRecord {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!ID.test(value.id) ||
		typeof value.cwd !== "string" ||
		typeof value.profile !== "string" ||
		typeof value.label !== "string" ||
		typeof value.model !== "string" ||
		typeof value.sessionPath !== "string" ||
		typeof value.updatedAt !== "string" ||
		(value.branch !== null && typeof value.branch !== "string") ||
		(value.ownerPid !== null && (!Number.isSafeInteger(value.ownerPid) || Number(value.ownerPid) < 1)) ||
		(value.status !== "active" && value.status !== "suspended" && value.status !== "stopped") ||
		(value.thinking !== undefined && typeof value.thinking !== "string")
	) {
		throw new Error("Invalid persistent-session recovery metadata");
	}
	return value as unknown as RecoveryRecord;
}

export class RecoveryStore {
	private readonly recordsDir: string;
	private readonly leaseDir: string;
	private readonly sessionDir: string;
	private readonly owned = new Set<string>();

	constructor(agentDir: string, sessionDir: string) {
		this.recordsDir = path.join(agentDir, "subagent-recovery");
		this.leaseDir = path.join(this.recordsDir, "leases");
		this.sessionDir = path.resolve(sessionDir);
	}

	private directories(): void {
		fs.mkdirSync(this.leaseDir, { recursive: true, mode: 0o700 });
	}

	private recordPath(id: string): string {
		if (!ID.test(id)) throw new Error("Invalid recovery id");
		return path.join(this.recordsDir, `${id}.json`);
	}

	private leasePath(id: string): string {
		if (!ID.test(id)) throw new Error("Invalid recovery id");
		return path.join(this.leaseDir, `${id}.lock`);
	}

	private verifySessionPath(candidate: string): string {
		const resolved = canonical(candidate);
		const expected = canonical(this.sessionDir);
		if (
			path.dirname(resolved) !== expected ||
			!resolved.endsWith(".jsonl") ||
			!fs.statSync(resolved).isFile() ||
			fs.lstatSync(candidate).isSymbolicLink()
		) {
			throw new Error("Recovery transcript must be a regular file in the configured subagent session directory");
		}
		return resolved;
	}

	private read(id: string): RecoveryRecord {
		const recordPath = this.recordPath(id);
		if (fs.lstatSync(recordPath).isSymbolicLink()) throw new Error("Recovery metadata cannot be a symlink");
		const record = parseRecord(JSON.parse(fs.readFileSync(recordPath, "utf8")));
		if (record.id !== id) throw new Error("Recovery id does not match the record name");
		return record;
	}

	private claim(id: string): void {
		this.directories();
		const file = this.leasePath(id);
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
				this.owned.add(id);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			// Serialize the stale-PID check and unlink. Without this guard, two
			// simultaneous restarts could both read the dead owner, and the slower
			// restart could delete the faster one's newly acquired lease.
			const reclaim = `${file}.reclaiming`;
			try {
				fs.mkdirSync(reclaim, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new Error("Another Pi process is reclaiming this session; retry after it finishes");
				}
				throw error;
			}
			try {
				let pid: unknown;
				try {
					if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Recovery lease cannot be a symlink");
					const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
					pid = isRecord(value) ? value.pid : undefined;
				} catch (readError) {
					if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw new Error("Recovery lease is unreadable; refusing to claim a possibly active session");
				}
				if (typeof pid !== "number" || alive(pid)) {
					throw new Error("Recovery session is already owned by a running Pi process");
				}
				try {
					fs.unlinkSync(file); // stale lease after a crashed parent
				} catch (removeError) {
					if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
				}
			} finally {
				fs.rmdirSync(reclaim);
			}
		}
		throw new Error("Recovery lease could not be acquired safely");
	}

	private releaseLease(id: string): void {
		if (!this.owned.delete(id)) return;
		const file = this.leasePath(id);
		try {
			fs.unlinkSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	/** Persist a newly spawned root-owned persistent worker after Pi reports its session file. */
	create(session: RecoverySession): RecoveryRecord {
		this.directories();
		const id = randomUUID();
		const record: RecoveryRecord = {
			version: 1,
			id,
			cwd: canonical(session.cwd),
			branch: branchAt(session.cwd),
			profile: session.profile,
			label: session.label,
			model: session.model,
			...(session.thinking ? { thinking: session.thinking } : {}),
			sessionPath: this.verifySessionPath(session.sessionPath),
			updatedAt: new Date().toISOString(),
			ownerPid: process.pid,
			status: "active",
		};
		this.claim(id);
		try {
			atomicJson(this.recordPath(id), record);
			return record;
		} catch (error) {
			this.releaseLease(id);
			throw error;
		}
	}

	/** Show only matching-project, matching-branch records. Active leases are not resumable. */
	list(cwd: string, limit = 20): { record: RecoveryRecord; available: boolean }[] {
		if (!fs.existsSync(this.recordsDir)) return [];
		const current = canonical(cwd);
		const branch = branchAt(cwd);
		const records: { record: RecoveryRecord; available: boolean }[] = [];
		for (const name of fs.readdirSync(this.recordsDir)) {
			if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
			let record: RecoveryRecord;
			try {
				record = this.read(name.slice(0, -5));
				if (record.cwd !== current || record.branch !== branch || record.status === "stopped") continue;
				this.verifySessionPath(record.sessionPath);
			} catch {
				continue; // never expose corrupt/foreign records
			}
			records.push({ record, available: !this.isLeased(record.id) });
		}
		records.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));
		return records.slice(0, Math.max(1, Math.min(limit, 100)));
	}

	private isLeased(id: string): boolean {
		const file = this.leasePath(id);
		if (!fs.existsSync(file)) return false;
		try {
			const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			return !isRecord(v) || typeof v.pid !== "number" || alive(v.pid);
		} catch {
			return true;
		}
	}

	/**
	 * Reserve a recorded transcript for one new root worker. Same project, branch,
	 * model, and profile must match. Changing providers may invalidate tool history.
	 * Caller must release(id) if starting its child fails.
	 */
	resume(id: string, cwd: string, profile: string, expectedModel: string): RecoveryRecord {
		const record = this.read(id);
		if (record.status === "stopped") throw new Error("This worker was explicitly stopped and cannot be recovered");
		if (record.cwd !== canonical(cwd)) throw new Error("Recovery belongs to another project directory");
		if (record.branch !== branchAt(cwd)) throw new Error("Git branch changed; do not reuse this implementer context");
		if (record.profile !== profile) throw new Error(`Recovery belongs to role ${record.profile}, not ${profile}`);
		if (record.model !== expectedModel)
			throw new Error(
				`Recovery uses ${record.model}, but the current profile requires ${expectedModel}; start a fresh worker or restore the previous model.`,
			);
		this.verifySessionPath(record.sessionPath);
		this.claim(id);
		try {
			const active: RecoveryRecord = {
				...record,
				ownerPid: process.pid,
				status: "active",
				updatedAt: new Date().toISOString(),
			};
			atomicJson(this.recordPath(id), active);
			return active;
		} catch (error) {
			this.releaseLease(id);
			throw error;
		}
	}

	/** Release on session shutdown / child failure; keep transcript for deliberate resumption. */
	suspend(id: string): void {
		if (!this.owned.has(id)) return;
		try {
			const old = this.read(id);
			atomicJson(this.recordPath(id), {
				...old,
				status: "suspended",
				ownerPid: null,
				updatedAt: new Date().toISOString(),
			} satisfies RecoveryRecord);
		} finally {
			this.releaseLease(id);
		}
	}

	/** Explicit agent_stop retires the record, rather than reviving a deliberately stopped worker. */
	retire(id: string): void {
		if (!this.owned.has(id)) return;
		try {
			const old = this.read(id);
			atomicJson(this.recordPath(id), {
				...old,
				status: "stopped",
				ownerPid: null,
				updatedAt: new Date().toISOString(),
			} satisfies RecoveryRecord);
		} finally {
			this.releaseLease(id);
		}
	}

	/** Convenience for session_shutdown; no background work is started. */
	suspendAll(): void {
		for (const id of [...this.owned]) this.suspend(id);
	}
}
