import assert from "node:assert/strict";
import { test } from "node:test";
import { completionContextContent } from "../notification.js";
import { formatParentMessage } from "../protocol.js";
import { AgentRegistry } from "../registry.js";

const corePackage = "@earendil-works/pi-agent-core";
const { Agent } = await import(corePackage);
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");

test("the next model request sees both tool output and each child update once", async () => {
	let requests = 0;
	let notifications = 0;
	const model = {
		id: "fixture",
		name: "fixture",
		provider: "fixture",
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
	};
	const registry = new AgentRegistry({
		notify: () => {
			notifications++;
		},
		supervisionIntervalMs: 0,
	});
	const child = {
		agentId: "ana",
		label: "ana",
		status: "completed" as const,
		stoppedByControl: false,
		markStopped() {},
		async stop() {},
	};
	registry.register(child);
	const seen: unknown[][] = [];
	const parent = new Agent({
		initialState: {
			model,
			tools: [
				{
					name: "work",
					label: "Work",
					description: "Produce a tool result while a child is active",
					parameters: { type: "object", properties: {} },
					execute: async () => {
						registry.queueParentMessageIfActive({
							to: "@parent",
							from: "ana",
							message: "Dependency ready",
							sentAt: 1794406899000,
						});
						await registry.complete(child, {
							status: "completed",
							output: "Implementation finished",
							stats: { tokens: 4, toolUses: 0, durationMs: 15 },
						});
						return { content: [{ type: "text" as const, text: "ORIGINAL_TOOL_RESULT" }], details: { original: true } };
					},
				},
			],
		},
		afterToolCall: ({
			result,
			isError,
		}: {
			result: { content: Array<{ type: "text"; text: string }>; details: unknown };
			isError: boolean;
		}) => {
			const { messages, completions } = registry.takePendingForToolResult();
			return {
				content: [
					...result.content,
					...messages.map((msg) => ({ type: "text" as const, text: formatParentMessage(msg) })),
					...completions.map(({ agent, completion }) => ({
						type: "text" as const,
						text: completionContextContent(agent, completion),
					})),
				],
				details: result.details,
				isError,
			};
		},
		streamFn: (_model: unknown, context: { messages: unknown[] }) => {
			seen.push(context.messages);
			requests++;
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant" as const,
				api: model.api,
				provider: model.provider,
				model: model.id,
				content:
					requests === 1
						? [{ type: "toolCall" as const, id: "work-1", name: "work", arguments: {} }]
						: [{ type: "text" as const, text: "done" }],
				stopReason: requests === 1 ? ("toolUse" as const) : ("stop" as const),
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
	await parent.prompt("start");
	registry.parentBecameIdle();
	assert.equal(requests, 2);
	assert.equal(notifications, 0);
	const last = JSON.stringify(seen[1]);
	for (const phrase of ["ORIGINAL_TOOL_RESULT", "Dependency ready", "Implementation finished"]) {
		assert.equal(last.split(phrase).length - 1, 1, `${phrase} must reach the model once`);
	}
});
