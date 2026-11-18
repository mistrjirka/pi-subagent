/**
 * A reusable turn-settlement latch.
 *
 * Pi emits agent_settled again for each new prompt in a persistent child.
 * The counter remembers a settle that arrives before a consumer attaches.
 * ignorePrior() is called when an idle resident is successfully woken for a
 * new turn, so old completion signals cannot finish the new revision.
 */
export class AgentSettlementLatch {
	private countValue = 0;
	private lastObserved = 0;
	private readonly waiters = new Set<() => void>();

	get count(): number {
		return this.countValue;
	}

	settle(): void {
		this.countValue++;
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	ignorePrior(): void {
		this.lastObserved = this.countValue;
	}

	waitForNext(isClosed: () => boolean): Promise<void> {
		if (isClosed()) return Promise.resolve();
		if (this.countValue > this.lastObserved) {
			this.lastObserved = this.countValue;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const onSettle = () => {
				this.waiters.delete(onSettle);
				this.lastObserved = this.countValue;
				resolve();
			};
			this.waiters.add(onSettle);
		});
	}
}
