# Profiled subagent runtime invariants

1. Agent output is normal assistant text. The runtime never requires a structured result schema.
2. `agent_spawn` accepts role/task/lifecycle intent only. It cannot set model, thinking, tools, timeout, or budgets.
3. The runtime contains no task-level tool/token/turn/time/concurrency/depth cap.
4. Root may spawn any discovered profile. A child may spawn only exact names in its own `allowed_subagents`; omitted means none.
5. Unknown profiles fail closed. There is no generic fallback role.
6. Model/thinking come from settings/profile configuration, then parent inheritance.
7. Existing configurations keep normal Pi tools. Optional toolGroups select additional tools while preserving enabled workspace, history and parent communication; selection is not a sandbox. Delegation permission is independent.
8. `ask_parent` targets the immediate spawning agent. A waiting child remains resident and the answer resumes the same context.
9. Review/acceptance workflow is the root parent's responsibility, not a runtime policy.
10. External UI integration is a direct status/steer/stop bridge only; it does not become a scheduler or workflow engine.
11. `agent_wait` uses a 150-second supervision window when no timeout is supplied, or a caller-chosen wait-window timeout when one is supplied. Expiry returns a live snapshot and never stops the child; it is not a task deadline.
12. When the root parent ends a turn with background/resumed children still running, each gets a 150-second fallback supervision window. A new parent turn or active wait pauses reminders; settlement/stop clears them. The reminder never terminates work.
13. Wait timeouts return incremental progress without reading transcripts. Recent inspection is a bounded preview that consumes neither final delivery nor edited-file deltas. Full inspection has a separate cursor and acknowledges a result only when the complete settled output is returned. Explicit diagnostics use an independent bounded context read and expose metadata, not message bodies. Failed reads and partial appends do not consume transcript messages.
14. Completion snapshots carry a work revision. A newer message, explicit stop, or registry shutdown invalidates older collection callbacks. Prompt acknowledgements cannot overwrite a newer settlement or question. Cached completed results remain inspectable.
15. Every hosting-session shutdown awaits owned-child teardown, clears pending announcements, and prevents late registration or completion from reviving the previous session's state.
16. External tool-start/end events mark actual execution boundaries. Model tool-call generation never marks execution as finished. Active-tool start times and explicit command timeouts are observational metadata, not task deadlines or progress guarantees.

18. Runtime completion does not assess task acceptance. Actual final delivery is acknowledged once; preview reads never acknowledge it. Parent-visible completion text is capped at 8,000 characters with full evidence available on demand.
