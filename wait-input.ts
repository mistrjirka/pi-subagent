import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ActiveWait = {
	sessionId: string;
	interrupt: () => void;
};

// The PiTTy fork emits this only after user input enters its queue. Older Pi
// versions accept unknown event registrations but never emit this optional hook.
type InputQueuedAPI = {
	on(
		event: "input_queued",
		handler: (
			event: { mode: "steer" | "followUp"; source: "interactive" | "rpc" | "extension" },
			ctx: ExtensionContext,
		) => void,
	): unknown;
};

export type InputInterruptibleWait = {
	signal: AbortSignal;
	readonly interruptedByUser: boolean;
	dispose: () => void;
};

/** Releases active parent waits without aborting the parent turn or its children. */
export function registerWaitInput(pi: ExtensionAPI): {
	begin: (ctx: ExtensionContext, parentSignal?: AbortSignal) => InputInterruptibleWait;
} {
	const active = new Set<ActiveWait>();
	const onInputQueued = pi.on.bind(pi) as unknown as InputQueuedAPI["on"];
	onInputQueued("input_queued", (event, ctx) => {
		if (
			(event.mode !== "steer" && event.mode !== "followUp") ||
			(event.source !== "rpc" && event.source !== "interactive")
		)
			return;
		const sessionId = ctx.sessionManager.getSessionId();
		for (const wait of active) {
			if (wait.sessionId === sessionId) wait.interrupt();
		}
	});

	return {
		begin(ctx, parentSignal) {
			const sessionId = ctx.sessionManager.getSessionId();
			const controller = new AbortController();
			let interruptedByUser = false;
			const dispose = () => {
				active.delete(wait);
				parentSignal?.removeEventListener("abort", onParentAbort);
			};
			const onParentAbort = () => {
				dispose();
				controller.abort(parentSignal?.reason);
			};
			const wait: ActiveWait = {
				sessionId,
				interrupt() {
					if (controller.signal.aborted) return;
					interruptedByUser = true;
					dispose();
					controller.abort();
				},
			};
			if (parentSignal?.aborted) {
				controller.abort(parentSignal.reason);
			} else {
				active.add(wait);
				parentSignal?.addEventListener("abort", onParentAbort, { once: true });
				// Input may already be queued when this tool starts. Do not require
				// a second input_queued event to release this wait.
				// New runtimes distinguish accepted user input from background notifications.
				const inputContext = ctx as ExtensionContext & { hasPendingUserInput?: () => boolean };
				if (inputContext.hasPendingUserInput?.() ?? ctx.hasPendingMessages()) wait.interrupt();
			}
			return {
				signal: controller.signal,
				get interruptedByUser() {
					return interruptedByUser;
				},
				dispose,
			};
		},
	};
}
