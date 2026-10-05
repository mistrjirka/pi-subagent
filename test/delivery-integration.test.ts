import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyCompletion } from "../notification.js";
import { AgentRegistry } from "../registry.js";

const corePackage = "@earendil-works/pi-agent-core";
const aiPackage = "@earendil-works/pi-ai";
const { Agent } = await import(corePackage);
const { createAssistantMessageEventStream } = await import(aiPackage);

for (const consume of [false, true]) {
	test(`real agent loop: ${consume ? "inspection prevents replay" : "completion reaches the next request before the answer"}`, async () => {
		let requests = 0;
		let sent = 0;
		const seen: string[] = [];
		const child = {
			agentId: "una",
			label: "Una",
			stoppedByControl: false,
			markStopped: () => {},
			status: "completed" as const,
			stop: async () => {},
		};
		const completion = {
			status: "completed" as const,
			output: "UNIQUE_CHILD_REPORT",
			stats: { tokens: 10, toolUses: 0, durationMs: 1 },
		};
		const pi = {
			sendMessage(message: { content: string }, options: { deliverAs: string }) {
				assert.equal(options.deliverAs, "steer");
				sent++;
				parent.steer({ role: "user", content: message.content, timestamp: Date.now() });
			},
		};
		const registry = new AgentRegistry({
			notify: (agent, result) => notifyCompletion(pi as never, agent, result),
			supervisionIntervalMs: 0,
		});
		registry.register(child);
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
		const parent = new Agent({
			initialState: {
				model,
				tools: [
					{
						name: "work",
						label: "Work",
						description: "complete child during tool execution",
						parameters: { type: "object", properties: {} },
						execute: async () => {
							await registry.complete(child, completion);
							assert.equal(sent, 0, "do not inject midway through tool execution");
							if (consume) registry.consumeSettlement("una");
							return { content: [{ type: "text", text: "tool complete" }], details: {} };
						},
					},
				],
			},

			streamFn: (_model: unknown, context: { messages: unknown[] }) => {
				seen.push(JSON.stringify(context.messages));
				requests++;
				assert.ok(requests <= 2, "duplicate triggered an extra model request");
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content:
						requests === 1
							? [{ type: "toolCall", id: "work-1", name: "work", arguments: {} }]
							: [{ type: "text", text: "final answer" }],
					stopReason: requests === 1 ? "toolUse" : "stop",
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
		parent.subscribe((event: { type: string }) => {
			if (event.type === "turn_end") registry.parentReachedBoundary();
		});
		await parent.prompt("start");
		registry.parentBecameIdle();
		assert.equal(requests, 2);
		assert.equal(sent, consume ? 0 : 1);
		assert.equal(seen[1].includes("UNIQUE_CHILD_REPORT"), !consume);
	});
}
