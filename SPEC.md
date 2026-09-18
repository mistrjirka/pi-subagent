# Profiled subagent runtime invariants

1. Agent output is normal assistant text. The runtime never requires a structured result schema.
2. `agent_spawn` accepts role/task/lifecycle intent only. It cannot set model, thinking, tools, timeout, or budgets.
3. The runtime contains no task-level tool/token/turn/time/concurrency/depth cap.
4. Root may spawn any discovered profile. A child may spawn only exact names in its own `allowed_subagents`; omitted means none.
5. Unknown profiles fail closed. There is no generic fallback role.
6. Model/thinking come from settings/profile configuration, then parent inheritance.
7. All normal Pi tools remain available to children; delegation permission is independent from tool permission.
8. `ask_parent` targets the immediate spawning agent. A waiting child remains resident and the answer resumes the same context.
9. Review/acceptance workflow is the root parent's responsibility, not a runtime policy.
10. External UI integration is a direct status/steer/stop bridge only; it does not become a scheduler or workflow engine.
11. `agent_wait` uses a 180-second supervision window when no timeout is supplied, or a caller-chosen wait-window timeout when one is supplied. Expiry returns a live snapshot and never stops the child; it is not a task deadline.
12. When the root parent ends a turn with background/resumed children still running, each gets a 3-minute fallback supervision window. A new parent turn or active wait pauses reminders; settlement/stop clears them. The reminder never terminates work.
13. `agent_inspect` is read-only and exposes a bounded recent child transcript. It prefers Pi RPC, falls back to the persisted session and then the live event stream, and never silently turns an RPC failure into an empty transcript. Supervision views include plaintext thinking when available; thinking expansion is additive and must not reduce the selected tool/message evidence.
