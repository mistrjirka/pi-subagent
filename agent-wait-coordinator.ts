import type { AgentMessage } from "./protocol.js";
import type { AgentSettlement, AgentWaitEvent, AgentWaitMessage } from "./registry-contracts.js";
import type { SupervisionService } from "./supervision.js";

type WaitResult = AgentSettlement | AgentWaitEvent | null | undefined;
type Waiter = (result: WaitResult) => void;

/**
 * Owns wait subscriptions for direct children.
 * Completion delivery and parent wake policy remain in AgentRegistry.
 * Only one waiter receives a message payload; parallel waiters receive a
 * lightweight other_wait event so the model cannot count one message twice.
 */
export class AgentWaitCoordinator {
	private readonly settlementWaiters = new Map<string, Set<Waiter>>();
	private readonly messageWaiters = new Set<(message: AgentWaitEvent) => void>();

	constructor(private readonly supervisor: Pick<SupervisionService, "pause" | "resume">) {}

	settle(agentId: string, settlement: AgentSettlement): boolean {
		const waiters = this.settlementWaiters.get(agentId);
		if (!waiters?.size) return false;
		this.settlementWaiters.delete(agentId);
		let first = true;
		for (const resolve of [...waiters]) {
			resolve(first ? settlement : { kind: "other_wait", reason: "completion" });
			first = false;
		}
		return true;
	}

	wakeForMessage(message: AgentMessage): boolean {
		if (this.messageWaiters.size === 0) return false;
		const event: AgentWaitMessage = { kind: "message", message };
		let first = true;
		for (const wake of [...this.messageWaiters]) {
			wake(first ? event : { kind: "other_wait", reason: "message" });
			first = false;
		}
		return true;
	}

	async wait(agentId: string, signal?: AbortSignal, timeoutMs?: number, wakeOnMessage = false): Promise<WaitResult> {
		if (signal?.aborted) throw new Error("agent_wait cancelled");
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new Error("agent_wait timeout must be a finite non-negative duration");
		}
		this.supervisor.pause(agentId);
		if (timeoutMs === 0) {
			this.supervisor.resume(agentId);
			return null;
		}
		return await new Promise<WaitResult>((resolve, reject) => {
			const waiters = this.settlementWaiters.get(agentId) ?? new Set<Waiter>();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const detachWaiter = () => {
				waiters.delete(finish);
				if (waiters.size === 0) this.settlementWaiters.delete(agentId);
			};
			const cleanup = () => {
				detachWaiter();
				this.messageWaiters.delete(wake);
				signal?.removeEventListener("abort", onAbort);
				if (timer) clearTimeout(timer);
				this.supervisor.resume(agentId);
			};
			const finish = (event: WaitResult) => {
				cleanup();
				resolve(event);
			};
			const wake = (event: AgentWaitEvent) => finish(event);
			const onAbort = () => {
				cleanup();
				reject(new Error("agent_wait cancelled"));
			};
			waiters.add(finish);
			this.settlementWaiters.set(agentId, waiters);
			if (wakeOnMessage) this.messageWaiters.add(wake);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs !== undefined) timer = setTimeout(() => finish(null), timeoutMs);
		});
	}

	shutdown(): void {
		for (const waiters of [...this.settlementWaiters.values()]) {
			for (const resolve of [...waiters]) resolve(undefined);
		}
		this.settlementWaiters.clear();
		this.messageWaiters.clear();
	}
}
