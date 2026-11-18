import type { RegisteredAgent } from "./registry-contracts.js";

/**
 * Owns fallback supervision timers for a parent's direct children.
 * The registry owns child lifetime, completion delivery, and wait subscriptions.
 * This service never sends model messages or changes child process state.
 */
export class SupervisionService {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly supervised = new Set<string>();
	private readonly activeWaits = new Map<string, number>();
	private readonly lastSupervisedAt = new Map<string, number>();
	private parentActive = true;

	constructor(
		private readonly options: {
			lookup: (agentId: string) => RegisteredAgent | undefined;
			remind: (agent: RegisteredAgent, unsupervisedMs: number) => Promise<void> | void;
			intervalMs: number;
		},
	) {}

	/** Start supervision only for agents explicitly registered by the parent. */
	start(agentId: string): void {
		if (this.options.intervalMs <= 0 || !this.options.lookup(agentId)) return;
		this.supervised.add(agentId);
		this.lastSupervisedAt.set(agentId, Date.now());
		this.schedule(agentId);
	}

	parentBecameActive(): void {
		this.parentActive = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	parentBecameIdle(): void {
		this.parentActive = false;
		const now = Date.now();
		for (const agentId of this.supervised) {
			this.lastSupervisedAt.set(agentId, now);
			this.schedule(agentId);
		}
	}

	/** Reset an existing clock without creating supervision for a new child. */
	touch(agentId: string): void {
		if (!this.supervised.has(agentId)) return;
		this.lastSupervisedAt.set(agentId, Date.now());
		this.schedule(agentId);
	}

	/** Pauses reminders during explicit agent_wait. Nested waits are counted. */
	pause(agentId: string): void {
		this.activeWaits.set(agentId, (this.activeWaits.get(agentId) ?? 0) + 1);
		this.clearTimer(agentId);
	}

	resume(agentId: string): void {
		const count = Math.max(0, (this.activeWaits.get(agentId) ?? 0) - 1);
		if (count) this.activeWaits.set(agentId, count);
		else this.activeWaits.delete(agentId);
		if (!this.supervised.has(agentId)) return;
		this.lastSupervisedAt.set(agentId, Date.now());
		if (!count) this.schedule(agentId);
	}

	stop(agentId: string): void {
		this.clearTimer(agentId);
		this.supervised.delete(agentId);
		this.activeWaits.delete(agentId);
		this.lastSupervisedAt.delete(agentId);
	}

	private clearTimer(agentId: string): void {
		const timer = this.timers.get(agentId);
		if (timer) clearTimeout(timer);
		this.timers.delete(agentId);
	}

	private schedule(agentId: string): void {
		this.clearTimer(agentId);
		if (
			this.options.intervalMs <= 0 ||
			this.parentActive ||
			!this.supervised.has(agentId) ||
			(this.activeWaits.get(agentId) ?? 0) > 0
		)
			return;

		const agent = this.options.lookup(agentId);
		if (!agent || (agent.status && agent.status !== "running" && agent.status !== "queued")) return;
		const timer = setTimeout(() => {
			this.timers.delete(agentId);
			const current = this.options.lookup(agentId);
			if (!current || (current.status && current.status !== "running" && current.status !== "queued")) return;
			if (this.parentActive || (this.activeWaits.get(agentId) ?? 0) > 0) return;
			const now = Date.now();
			const since = now - (this.lastSupervisedAt.get(agentId) ?? now);
			this.lastSupervisedAt.set(agentId, now);
			void Promise.resolve(this.options.remind(current, since)).catch(() => {});
			this.schedule(agentId);
		}, this.options.intervalMs);
		this.timers.set(agentId, timer);
	}
}
