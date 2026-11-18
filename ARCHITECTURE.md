# Runtime boundaries

- `tool-params.ts` defines Pi tool schemas and derives argument types with TypeBox `Static`. The `agent_spawn` schema is different for root and child processes. The single explicit `SpawnParams` cast at the registered handler is the boundary for that runtime-dependent choice; other tool handlers use inferred schema types.
- `spawn-coordinator.ts` makes an admission decision before launching a child. It resolves the named profile and model, enforces delegation/background policy, and claims any explicitly requested recovery. It takes a narrow `RecoveryPort` and injectable profile/model services. It never renders a card or starts a process.
- `spawn-session.ts` owns foreground, background, abort and resident lifetime transitions once an `AgentProcess` exists. `agent-process.ts` owns the one child Pi RPC process and translates its messages to domain events.
- `agent-telemetry.ts` owns completed-turn count, executed-tool count, last activity and current context usage. `external-control.ts` publishes this bounded snapshot in `status.json`. It does not scan a full Pi session or store token histories. `message_end` with assistant usage updates the context window; a tool-result end clears an active tool without double-counting.
- `registry.ts` owns per-parent child lifecycle, routing, waiting and completion deduplication. `notification.ts` constructs the model-visible completion and display card. The UI should not reimplement registry policy.
- `index.ts` wires the above services to Pi extension hooks. Its remaining orchestration is a future extraction seam; changes should follow contract tests rather than rewrite lifecycle and delivery simultaneously.

## Status protocol

`status.json` retains version 1. New optional, nonnegative fields `turnCount`, `toolCount`, `windowTokens` and `lastActivityAt` record completed assistant messages, unique started executions, most recent model input window including cache tokens, and genuine activity timestamp (not heartbeat). Legacy consumers may ignore these fields; new consumers use them instead of reading session-file tails. An idle child can remain resident and have nonzero counters.

## Type safety

Validate untrusted RPC and filesystem records at their ingress. Preserve typed domain values after that. Prefer narrow structural dependencies to casting a whole service to `unknown` and back. Keep DOM/TUI state out of business policies.
