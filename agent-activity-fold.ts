import type { AgentActivity, AgentEvent } from "./event-interpret.js";
import type { RenderEvent } from "./types.js";

export type ActivityCallbacks = {
	onDelta?: (delta: string) => void;
	onActivityChange?: (activity: AgentActivity) => void;
	onStream?: (event: AgentEvent) => void;
};

/**
 * One child process's presentation-only activity fold. Pi event translation
 * lives in event-interpret.ts. This class owns rendered excerpts and the
 * ordered UI trace, without deciding child lifecycle or model settlements.
 */
export class AgentActivityFold {
	private latest: AgentActivity | undefined;
	private readonly events: RenderEvent[] = [];

	constructor(private readonly callbacks: ActivityCallbacks = {}) {}

	latestActivity(): AgentActivity | undefined {
		return this.latest;
	}

	getEvents(): RenderEvent[] {
		return this.events;
	}

	/**
	 * True means the event was presentation-only and has been fully handled.
	 * False leaves lifecycle, questions, errors and messages to AgentProcess.
	 */
	handle(event: AgentEvent): boolean {
		switch (event.type) {
			case "assistant_start":
			case "assistant_end":
			case "tool_execution_start":
			case "tool_execution_end":
			case "tool_result_end":
			case "tool_start":
				this.callbacks.onStream?.(event);
				return true;
			case "thinking": {
				const chunk = event.text ?? "";
				const last = this.events[this.events.length - 1];
				if (last?.kind === "thinking") {
					last.text = (last.text ?? "") + chunk;
				} else {
					this.events.push({ kind: "thinking", text: chunk, ts: Date.now() });
				}
				const activity: AgentActivity = {
					kind: "thinking",
					text: last?.kind === "thinking" ? (last.text ?? "") : chunk,
				};
				this.latest = activity;
				this.callbacks.onActivityChange?.(activity);
				this.callbacks.onStream?.(event);
				return true;
			}
			case "tool_call":
				// Only toolcall_end contains authoritative arguments. Start/end
				// execution markers are forwarded but do not create duplicate rows.
				this.events.push({ ...event.activity, ts: Date.now() });
				this.latest = event.activity;
				this.callbacks.onActivityChange?.(event.activity);
				this.callbacks.onStream?.(event);
				return true;
			case "text_delta": {
				const last = this.events[this.events.length - 1];
				if (last?.kind === "text") {
					last.text += event.delta;
				} else {
					this.events.push({ kind: "text", text: event.delta, ts: Date.now() });
				}
				this.latest = {
					kind: "text",
					text: last?.kind === "text" ? last.text : event.delta,
				};
				this.callbacks.onDelta?.(event.delta);
				this.callbacks.onStream?.(event);
				return true;
			}
			default:
				return false;
		}
	}
}
