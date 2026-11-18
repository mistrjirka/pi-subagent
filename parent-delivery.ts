/** Parent model-turn boundaries and completion delivery policy. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MessageRouter } from "./message-router.js";
import { completionContextContent } from "./notification.js";
import { formatParentMessage } from "./protocol.js";
import type { AgentRegistry } from "./registry.js";

export function registerToolErrorHook(pi: ExtensionAPI): void {
	// pi's agent-core drops the execute() isError flag when a tool returns
	// normally (bash gets its error background by throwing instead) — see
	// agent-core executePreparedToolCall. Re-attach it for our tools by
	// marking every error path in `details.error`; the handler restores
	// isError so failed calls render with toolErrorBg like bash, while
	// keeping the details (status line) intact.
	pi.on("tool_result", async (event) => {
		if (
			event.toolName !== "agent_recover" &&
			event.toolName !== "agent_spawn" &&
			event.toolName !== "agent_wait" &&
			event.toolName !== "agent_inspect" &&
			event.toolName !== "agent_stop" &&
			event.toolName !== "agent_send" &&
			event.toolName !== "ask_parent"
		) {
			return undefined;
		}
		const details = event.details as { error?: unknown } | undefined;
		if (!details || details.error === undefined) return undefined;
		return { isError: true };
	});
}
export function registerParentDeliveryHooks(pi: ExtensionAPI, registry: AgentRegistry, router: MessageRouter): void {
	// Every Pi session can own a resident child, even though only the root may
	// spawn background work. Track the parent's actual active/settled window at
	// every depth so resumed-child announcements cannot race a late agent_wait.
	pi.on("agent_start", () => registry.parentBecameActive());
	// If progress arrives after the last tool result, steer it at the next
	// model-turn boundary rather than holding it until the parent fully settles.
	// Completions remain deferred, because agent_wait may still consume them.
	pi.on("turn_end", () => {
		for (const message of registry.takePendingParentMessages()) {
			router.deliverParentMessage(message);
			registry.noteDeliveredParentMessage(message);
		}
	});
	// Do not announce at turn_end: Pi queues the steer immediately, but a later
	// agent_wait can consume the same result before that steer reaches the model.
	// A tool result reports earlier completions; idle is the fallback boundary.
	pi.on("agent_settled", () => {
		const messages = registry.takePendingParentMessages();
		// Pi can settle without emitting another turn_end. Publish and account
		// for pending child progress *before* checking whether the completion
		// needs a new parent turn. Otherwise idle sends the completion first
		// and starts a redundant model request before the progress is counted.
		for (const message of messages) {
			router.deliverParentMessage(message);
			registry.noteDeliveredParentMessage(message);
		}
		registry.parentBecameIdle();
	});

	// A tool result is the next safe model-visible boundary during an active turn.
	// Consume once, while preserving the original tool output and error flag.
	pi.on("tool_result", (event) => {
		const { messages, completions } = registry.takePendingForToolResult();
		if (!messages.length && !completions.length) return undefined;
		const text = [
			"[Subagent updates received during this turn]",
			...messages.map((message) => `Message: ${formatParentMessage(message)}`),
			...completions.map(({ agent, completion }) => `Completion: ${completionContextContent(agent, completion)}`),
		].join("\n");
		return {
			content: [...event.content, { type: "text", text }],
			details: event.details,
			isError: event.isError,
			usage: event.usage,
		};
	});
}
