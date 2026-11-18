/** One per-process message router for direct children and the parent status channel. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MSG_STATUS_KEY } from "./event-interpret.js";
import { type AgentMessage, formatFrom, formatParentMessage } from "./protocol.js";
import type { AgentRegistry } from "./registry.js";

export interface StatusWriter {
	setStatus(key: string, value: string | undefined): void;
}
export interface MessageRouteResult {
	ok: boolean;
	verb?: string;
	error?: string;
}

export class MessageRouter {
	constructor(
		private readonly pi: Pick<ExtensionAPI, "sendMessage">,
		private readonly registry: Pick<
			AgentRegistry,
			| "wakeWaitForMessage"
			| "queueParentMessageIfActive"
			| "noteDeliveredParentMessage"
			| "route"
			| "lookup"
			| "deliver"
		>,
		private readonly getStatusWriter: () => StatusWriter | undefined,
	) {}

	/** Keep the original custom-message UI when the parent is idle. */
	deliverParentMessage(msg: AgentMessage): void {
		this.pi.sendMessage(
			{
				customType: "subagent-message",
				content: formatParentMessage(msg),
				display: true,
				details: {
					from: msg.from,
					message: msg.message,
					...(msg.sentAt ? { sentAt: msg.sentAt } : {}),
					...(msg.kind ? { kind: msg.kind } : {}),
				},
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	/**
	 * Route one in-tree message through the tree (per-hop O(1) against my
	 * direct children). Shared by the agent_send tool (outbound: the caller
	 * gets a synchronous result) and the inbound handler (child→parent: no
	 * return path, so errors are delivered back to the sender as messages).
	 *
	 *   direct child → rpc prompt + steer (wakes idle, queues on running)
	 *   "@parent"   → the parent injects it into its LLM (or mine, inbound)
	 *   unknown     → explicit error (routing is the LLM's job, hop by hop);
	 *                 on the inbound path the sender is told best-effort
	 */
	async route(msg: AgentMessage, outbound: boolean, answerToQuestion = false): Promise<MessageRouteResult> {
		if (!outbound && msg.to === "@parent") {
			// Finish an active agent_wait now. The tool result delivers the message;
			// queueing a steer too would show it a second time.
			if (this.registry.wakeWaitForMessage(msg)) return { ok: true, verb: "delivered" };
			// A child addressing "@parent" means this receiving session. Do not
			// re-route it using this process's own parent capability: at the root
			// that would incorrectly turn a successful child→root delivery into
			// "root session has no parent".
			if (!this.registry.queueParentMessageIfActive(msg)) {
				this.deliverParentMessage(msg);
				this.registry.noteDeliveredParentMessage(msg);
			}
			return { ok: true, verb: "delivered" };
		}

		const d = this.registry.route(msg);
		switch (d.kind) {
			case "child": {
				// Point-to-point delivery to a direct child. Cross-level coordination
				// is the LLM's job: it addresses only ids it knows, hop by hop.
				const text = `${formatFrom(d.message.from)}${d.message.message}`;
				const queued = this.registry.lookup(d.childId)?.status === "running";
				const ok = await this.registry.deliver(d.childId, text, answerToQuestion);
				return ok
					? { ok: true, verb: queued ? "queued" : "accepted" }
					: { ok: false, error: `delivery to ${d.childId} failed` };
			}
			case "parent": {
				// Outbound only: inbound child→parent delivery is handled above.
				const writer = this.getStatusWriter();
				if (!writer)
					return { ok: false, error: "Cannot deliver to @parent: child extension UI channel is unavailable." };
				writer.setStatus(MSG_STATUS_KEY, JSON.stringify(d.message));
				// setStatus emits an event, but offers no parent-receipt acknowledgement.
				return { ok: true, verb: "sent" };
			}
			case "error": {
				if (!outbound && msg.from) {
					// Inbound path, no return channel: tell the sender (best-effort).
					void this.registry.deliver(msg.from, `[pi-subagent] agent_send to ${msg.to} failed: ${d.reason}`);
				}
				return { ok: false, error: d.reason };
			}
		}
	}
}
