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
11. `agent_wait` blocks on one direct child settlement with no framework timeout; shell sleep/poll loops are unnecessary.
