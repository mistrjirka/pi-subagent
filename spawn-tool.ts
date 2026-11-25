/** Registers agent_spawn. The root owns registries and cleanup; this owns one launch. */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AgentProcess } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";
import { ExternalControlBridge } from "./external-control.js";
import { createLiveChannels } from "./live-output.js";
import { recordSubagentPerformance } from "./model-performance-journal.js";
import type { AgentMessage, AgentQuestion } from "./protocol.js";
import type { RecoveryStore } from "./recovery.js";
import type { AgentRegistry } from "./registry.js";
import type { SpawnCoordinator } from "./spawn-coordinator.js";
import { childIdentityEnvironment } from "./spawn-identity.js";
import { presentBackgroundSpawn, presentFinishedSpawn, type SpawnPresentationContext } from "./spawn-result.js";
import { runSpawnSession, type SpawnOutcome } from "./spawn-session.js";
import { buildSpawnParamsSchema, canDelegate, type SpawnParams } from "./tool-params.js";
import { createSubtreeDisplay } from "./tree-display.js";
import type { TreeTelemetry } from "./tree-telemetry.js";
import type { SubagentDetails } from "./types.js";
import { spawnView } from "./views.js";
import type { AgentWidget } from "./widget.js";

export interface SpawnToolPorts {
	readonly hasParent: boolean;
	readonly allowedSubagents: readonly string[];
	readonly parentAgentId: string;
	readonly treeId: string;
	readonly sessionDir: string;
	readonly spawnableSummary: string;
	readonly registry: AgentRegistry;
	readonly spawnCoordinator: SpawnCoordinator;
	readonly tree: TreeTelemetry;
	readonly captureUi: (ctx: { mode: string; ui: ExtensionUIContext }) => void;
	readonly ensureWidget: (ctx: { mode: string; ui: ExtensionUIContext }) => AgentWidget | null;
	readonly getWidget: () => AgentWidget | undefined;
	readonly onChildMessage: (message: AgentMessage) => void;
	readonly childRecoveryIds: Map<string, string>;
	readonly controlBridges: Set<ExternalControlBridge>;
	readonly recovery: RecoveryStore | undefined;
	readonly toErrorResult: (error: unknown) => {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
		isError: true;
	};
}

/** Spawn-failure tool result: isError + the reason (LLM + user card share it). */
function spawnErrorResult(
	started: { error: string },
	extra: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	return {
		content: [{ type: "text", text: started.error }],
		details: { error: started.error, ...extra },
		isError: true,
	};
}

export function registerSpawnTool(pi: ExtensionAPI, ports: SpawnToolPorts): void {
	const hasParent: boolean = ports.hasParent;
	const parentAgentId: string = ports.parentAgentId;
	const treeId: string = ports.treeId;
	const sessionDir: string = ports.sessionDir;
	const registry: AgentRegistry = ports.registry;
	const tree: TreeTelemetry = ports.tree;
	const recovery: RecoveryStore | undefined = ports.recovery;
	const childRecoveryIds: Map<string, string> = ports.childRecoveryIds;
	const controlBridges: Set<ExternalControlBridge> = ports.controlBridges;
	const spawnCoordinator: SpawnCoordinator = ports.spawnCoordinator;
	const toErrorResult = ports.toErrorResult;
	const schema = buildSpawnParamsSchema(hasParent);
	if (canDelegate(hasParent, ports.allowedSubagents)) {
		// ── agent_spawn ────────────────────────────────────
		pi.registerTool({
			name: "agent_spawn",
			label: "Agent Spawn",
			description:
				`Spawn one configured agent profile. Available from this level: ${ports.spawnableSummary}. ` +
				"Profile/settings choose model and thinking; the spawn call cannot impose budgets, tool restrictions, or a timeout.",
			promptSnippet: `Delegate to a configured agent (${ports.spawnableSummary})`,
			promptGuidelines: [
				"Choose an exact configured agent name. Unknown agents fail; there is no fallback role.",
				"Address prompt to the selected child. Include its task, scope, constraints, evidence and required result. Keep parent-only launch decisions out; preserve requirements such as independently checking earlier conclusions or avoiding a rejected approach.",
				"Nested delegation is explicit: a sub-agent can spawn only names listed in its allowed_subagents profile field.",
				"If a child returns a question, answer that same resident child with agent_send kind=answer instead of starting a replacement.",
				...(!hasParent
					? [
							"Resolve recovery before spawning. Omit resume_id when a fresh context is required. Otherwise use agent_recover after a restart and resume only a matching project, branch, role and task. The prompt is a new instruction, not a launch command.",
							"Choose foreground/background with the tool field. Several independent spawns may run concurrently.",
						]
					: [
							"Nested spawns are foreground. Issue independent tool calls together when their work does not interfere.",
						]),
			],
			parameters: schema,

			async execute(_toolCallId, raw, signal, onUpdate, ctx) {
				ports.captureUi(ctx);
				const params: SpawnParams = raw;
				const decision = spawnCoordinator.prepare(params, {
					cwd: ctx.cwd,
					modelRegistry: ctx.modelRegistry,
					model: ctx.model,
				});
				if (decision.kind === "rejected")
					return {
						content: [{ type: "text", text: decision.message }],
						details: {
							...(decision.runInBackground ? { runInBackground: true, label: decision.label } : {}),
							...(decision.error === "background spawns are root-only" ? { label: decision.label } : {}),
							error: decision.error,
						},
						isError: true,
					};
				const { profile, runtimeProfile, label, task, runInBackground, resolved } = decision;
				let recoveryId = decision.recoveryId;
				const resumeSessionPath = decision.resumeSessionPath;

				const startedAt = Date.now();

				// Foreground: stream the sub-agent's session as an ordered activity
				// stream. AgentProcess accumulates RenderEvents internally at the
				// source (RPC event handler); the callbacks here only refresh the
				// live card via onUpdate.
				let streamed = "";
				// Where my child's subtree telemetry lands (SPEC: 显示面统一规则) —
				// fold into THIS card while it's open, forward to my parent, or
				// surface on the root widget. One module owns the whole decision.
				const subtree = createSubtreeDisplay({
					hasParent: hasParent,
					foregroundEdge: !runInBackground,
					getWidget: () => {
						ports.ensureWidget(ctx);
						return ports.getWidget();
					},
					forward: (event) => tree.report(event),
					onFold: () =>
						onUpdate?.({
							content: [{ type: "text", text: streamed }],
							details: liveDetails(agent.getLatestActivity()),
						}),
				});
				// Live-card details: the shared slice every foreground update carries.
				const liveDetails = (activity?: AgentActivity): SubagentDetails => ({
					task,
					runtime: "profiled-subagents",
					profile: profile.name,
					treeId: treeId,
					parentAgentId: parentAgentId || "root",
					agentId,
					controlDir: control?.controlDir,
					statusPath: control?.statusPath,
					state: agent?.awaitingParent ? "waiting" : agent?.status,
					startedAt,
					model: agent.model,
					thinking: agent.thinking,
					lastRequestPerformance: agent.getLatestRequestPerformance(),
					activity,
					events: agent.getEvents(),
					nested: subtree.nested(),
				});
				// Short human-name id (max, zoe…) — the LLM-facing reference. No tree
				// structure: agents address only ids they were given, hop by hop.
				const agentId = registry.nextAgentId();
				let pendingQuestion: AgentQuestion | undefined;
				const notifyQuestion = (question: AgentQuestion): void => {
					pi.sendMessage(
						{
							customType: "subagent-question",
							content: JSON.stringify({
								agent_id: `@${agentId}`,
								profile: profile.name,
								question: question.question,
								context: question.context ?? null,
							}),
							display: true,
							details: { agentId, profile: profile.name, label, ...question },
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				};
				const wakeCompletion = (status: "completed" | "failed", generation: number) =>
					agent.completionForTurn(status, generation);

				const live = createLiveChannels({
					// getWidget, not widget: the widget is created on first use, so a
					// captured reference would be null for every update before that.
					surfaces: { getWidget: () => ports.getWidget(), tree },
					// Live tail for external readers (PiTTy): attached for BOTH spawn
					// modes — unlike `card` below, which exists only for foreground.
					// `control` is assigned below before any event can flow.
					stream: (event) => control.appendEvents(event),
					...(runInBackground
						? {}
						: {
								card: {
									delta: (text: string) => {
										streamed += text;
										onUpdate?.({
											content: [{ type: "text", text: streamed }],
											details: liveDetails(agent.getLatestActivity()),
										});
									},
									activity: (activity: AgentActivity) => {
										onUpdate?.({ content: [{ type: "text", text: streamed }], details: liveDetails(activity) });
									},
								},
							}),
				});

				const agent = new AgentProcess({
					onPerformance: recordSubagentPerformance,
					agentId,
					cwd: ctx.cwd,
					model: resolved.model,
					thinking: runtimeProfile.resolvedThinking ?? pi.getThinkingLevel(),
					appendSystemPrompt: runtimeProfile.prompt || undefined,
					label,
					taskSummary: task,
					sessionDir: sessionDir,
					resumeSessionPath,
					// Resident after completion (idle, zero token) — explicit opt-in.
					persistent: params.persistent === true || Boolean(params.resume_id),
					...(recovery && (params.persistent || params.resume_id)
						? {
								onSessionReady: (sessionPath: string) => {
									if (recoveryId) {
										if (path.resolve(sessionPath) !== path.resolve(resumeSessionPath ?? "")) {
											throw new Error("Resumed Pi session did not return the expected transcript path");
										}
									} else {
										const record = recovery.create({
											cwd: ctx.cwd,
											profile: profile.name,
											label,
											model: resolved.model ?? "inherited",
											thinking: runtimeProfile.resolvedThinking ?? pi.getThinkingLevel(),
											sessionPath,
										});
										recoveryId = record.id;
									}
									childRecoveryIds.set(agentId, recoveryId);
								},
							}
						: {}),
					// Identity for in-tree messaging: PI_SUBAGENT_AGENT_ID marks this
					// process as a child (agent_send is registered on every instance).
					env: childIdentityEnvironment(
						agentId,
						profile,
						treeId,
						parentAgentId,
						process.env.PI_SUBAGENT_ANCESTOR_IDS,
						runtimeProfile.resolvedToolGroups,
					),
					// Child→parent messages re-enter the router on this hop. Tree telemetry
					// from deeper spawns forwards up (depth + 1) or lands on the root widget.
					onMessage: ports.onChildMessage,
					onQuestion: (question) => {
						pendingQuestion = question;
					},
					onTreeEvent: (event) => subtree.onTreeEvent(event),
					// A wake finished. Completed: its output must reach this spawner's
					// context — symmetric with the first-completion notification, an
					// agent_send "delivered" alone would leave the answer unread.
					// Deliberate stops stay silent (stoppedByControl). A failed
					// follow-up is reported (abnormal end) then cleaned up.
					onIdle: (outcome, generation) => {
						if (outcome === "completed") {
							if (agent.awaitingParent && agent.pendingQuestion) {
								const question = agent.pendingQuestion;
								pendingQuestion = question;
								void wakeCompletion("completed", generation)
									.then((completion) => {
										if (!registry.acceptsCompletion(agent, completion)) return;
										registry.recordSettlement(
											agentId,
											{
												completion,
												waitingForParent: true,
												question,
											},
											question ? () => notifyQuestion(question) : undefined,
										);
										registry.markIdle(agentId);
									})
									.catch((error) => {
										pi.sendMessage(
											{
												customType: "subagent-error",
												content: `Subagent @${agentId} completion failed: ${String(error)}`,
												display: true,
											},
											{ deliverAs: "followUp", triggerTurn: true },
										);
									});
								return;
							}
							// A resumed ask_parent turn is a normal completion, not an
							// explicit stop. Finish collecting its output and record the
							// settlement before normal cleanup. Calling stopAndRemove here
							// races wakeCompletion(): markStopped() can otherwise overwrite
							// the just-produced final answer with a synthetic "stopped"
							// settlement before agent_wait receives it.
							void wakeCompletion("completed", generation)
								.then(async (completion) => {
									const accepted = await registry.complete(agent, completion);
									if (accepted && !agent.persistent) tree.remove(agentId, "done");
								})
								.catch((error) => {
									pi.sendMessage(
										{
											customType: "subagent-error",
											content: `Subagent @${agentId} completion failed: ${String(error)}`,
											display: true,
										},
										{ deliverAs: "followUp", triggerTurn: true },
									);
								});
							return;
						}
						void wakeCompletion("failed", generation)
							.then(async (completion) => {
								if (!(await registry.complete(agent, completion))) return;
								const recordId = childRecoveryIds.get(agentId);
								if (recordId) recovery?.suspend(recordId);
								tree.remove(agentId, "failed");
							})
							.catch((error) => {
								pi.sendMessage(
									{
										customType: "subagent-error",
										content: `Subagent @${agentId} completion failed: ${String(error)}`,
										display: true,
									},
									{ deliverAs: "followUp", triggerTurn: true },
								);
							});
					},
					// Where live output goes lives in live-output.ts: the widget row and
					// the tree fold hear about every update (a woken resident agent has a
					// row and no card), and the card below exists only for a foreground
					// spawn while its tool call runs. The events.jsonl tail additionally
					// hears about every mapped record in BOTH modes via onStream.
					onDelta: (delta) => live.onDelta(agent, delta),
					onActivityChange: (activity) => live.onActivity(agent, activity),
					onStream: (event) => live.onStream(agent, event),
				});
				const control = new ExternalControlBridge(
					agent,
					{
						profile: profile.name,
						parentPid: process.pid,
						treeId: treeId,
						parentAgentId: parentAgentId || "root",
					},
					{
						steer: async (message) => {
							const ok = registry.lookup(agentId)
								? await registry.deliver(agentId, message)
								: await agent.sendMessage(message);
							if (ok && !hasParent) registry.startSupervision(agentId);
							return ok;
						},
						stop: async () => {
							if (registry.lookup(agentId)) {
								const stopped = await registry.stopAndRemove(agentId);
								if (stopped) {
									tree.remove(agentId, "stopped");
									const recordId = childRecoveryIds.get(agentId);
									if (recordId) recovery?.retire(recordId);
								}
							} else {
								await agent.stop();
							}
						},
					},
				);
				controlBridges.add(control);
				control.start();

				// Lifecycle lives in spawn-session.ts — this switch only formats
				// outcomes into tool results; classification rules are table-tested
				// in test/spawn-session.test.ts.
				let outcome: SpawnOutcome;
				try {
					outcome = await runSpawnSession(agent, {
						task,
						runInBackground,
						signal,
						hooks: {
							onWorking: () =>
								onUpdate?.({
									content: [{ type: "text", text: "Working\u2026" }],
									details: liveDetails(),
								}),
							onBackgroundStarting: () =>
								onUpdate?.({
									content: [{ type: "text", text: `Starting ${agent.label}\u2026` }],
									details: { ...liveDetails(), runInBackground: true },
								}),
							// Background settled: wire widget + registry + the completion
							// chain here (mechanisms stay on this side of the seam).
							onBackgroundSettled: () => {
								ports.ensureWidget(ctx); // widget row added via the registry (non-TUI: no-op)
								registry.register(agent);
								if (!hasParent) registry.startSupervision(agent.agentId);
								tree.add(agent, "running"); // up-report: my child exists
								void agent
									.waitForCompletion()
									.then((completion) => {
										const child = agent;
										if (!registry.acceptsCompletion(child, completion)) return;
										if (completion.status === "completed" && child.awaitingParent && child.pendingQuestion) {
											const question = child.pendingQuestion;
											pendingQuestion = question;
											registry.recordSettlement(
												child.agentId,
												{
													completion,
													waitingForParent: true,
													question,
												},
												() => notifyQuestion(question),
											);
											registry.markIdle(child.agentId);
											return;
										}
										tree.remove(
											agent.agentId,
											completion.status === "completed"
												? "done"
												: completion.status === "failed"
													? "failed"
													: "stopped",
										);
										void registry.complete(child, completion);
										if (completion.status !== "completed") {
											const recordId = childRecoveryIds.get(child.agentId);
											if (recordId) recovery?.suspend(recordId);
										}
									})
									// Defensive: waitForCompletion normally resolves from child lifecycle events;
									// if it ever rejects, clean up without notifying.
									.catch(() => {
										tree.remove(agent.agentId, "stopped");
										registry.stopAndRemove(agent.agentId);
									});
							},
							onResident: () => {
								ports.ensureWidget(ctx);
								// Resident from birth: register the widget row as idle (‖
								// marker, stays addressable). Registering an already-completed
								// agent at its terminal status would be removed by the
								// widget's terminal cleanup before markIdle could flip it.
								registry.register(agent, "idle");
								tree.add(agent, "idle");
							},
							// Foreground settled: report the child upward (widget-rooted
							// nodes only — at the root the card itself is the display; a
							// card-contained node's subtree folds at its own anchor). This
							// closes the blind spot where a background agent's foreground
							// children were invisible entirely.
							onForegroundSettled: () => {
								if (hasParent) tree.add(agent, "running");
							},
						},
					});
				} catch (err) {
					if (recoveryId) recovery?.suspend(recoveryId);
					return toErrorResult(err);
				}

				subtree.closeCard(); // from here on onUpdate cannot refresh the card
				const presentation = (): SpawnPresentationContext => {
					const question = pendingQuestion ?? agent.pendingQuestion;
					return {
						agent,
						profile: profile.name,
						task,
						treeId: treeId,
						parentAgentId: parentAgentId || "root",
						controlDir: control.controlDir,
						statusPath: control.statusPath,
						startedAt,
						nested: subtree.nested(),
						...(resumeSessionPath ? { resumeSessionPath } : {}),
						...(recoveryId ? { recoveryId } : {}),
						...(question ? { pendingQuestion: question } : {}),
					};
				};
				switch (outcome.kind) {
					case "spawn-failed":
						if (recoveryId) {
							recovery?.suspend(recoveryId);
							childRecoveryIds.delete(agentId);
						}
						return spawnErrorResult(outcome, { runInBackground, label: agent.label });
					case "background-started": {
						const shown = presentBackgroundSpawn(presentation());
						if (shown.progress) onUpdate?.(shown.progress);
						return shown.result;
					}
					case "finished": {
						if (recoveryId && !outcome.resident) {
							if (outcome.stoppedByControl) recovery?.retire(recoveryId);
							else recovery?.suspend(recoveryId);
							childRecoveryIds.delete(agentId);
						}
						const shown = presentFinishedSpawn(outcome, presentation(), hasParent);
						if (shown.treeRemoval) tree.remove(agentId, shown.treeRemoval);
						return shown.result;
					}
				}
			},

			...spawnView,
		});
	}
}
