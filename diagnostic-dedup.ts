/** Bounded duplicate-suppression for successfully delivered diagnostics only. */
export class DiagnosticDeduplicator {
	private readonly sent = new Map<string, number>();

	wasSentRecently(target: string, message: string, now = Date.now()): boolean {
		const key = target + "\0" + message.trim().replace(/\s+/g, " ");
		const previous = this.sent.get(key);
		return previous !== undefined && now >= previous && now - previous < 600_000;
	}

	recordSent(target: string, message: string, now = Date.now()): void {
		for (const [key, at] of this.sent) {
			if (now - at >= 600_000) this.sent.delete(key);
		}
		const key = target + "\0" + message.trim().replace(/\s+/g, " ");
		this.sent.set(key, now);
		while (this.sent.size > 100) {
			const oldest = this.sent.keys().next().value;
			if (oldest === undefined) break;
			this.sent.delete(oldest);
		}
	}
}
