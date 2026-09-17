# @mistrjirka/pi-subagent

A small, profile-driven subagent runtime for [Pi](https://github.com/badlogic/pi-mono), forked from [`@everyx/pi-subagent`](https://github.com/everyx/pi-extensions/tree/master/packages/pi-subagent).

The runtime deliberately does very little orchestration. The **parent Pi decides the workflow**; this extension provides named child processes, communication, persistence, and explicit delegation rules.

## Design

- **No task caps.** No tool-call budget, token budget, turn budget, wall-clock deadline, concurrency ceiling, or nesting-depth ceiling.
- **No predefined roles.** Agent types are Markdown files you own.
- **No fallback agent.** An unknown agent name is an error.
- **Plain-text results.** A subagent finishes with ordinary assistant text. There is no required JSON/Zod/structured-output schema.
- **All normal Pi tools.** The runtime does not impose per-agent tool allowlists.
- **Explicit delegation.** A child may spawn only exact agent names listed in its profile's `allowed_subagents`. Omitted means none.
- **Persistent workers.** A child can stay resident after finishing and be continued with `agent_send` in the same context.
- **Explicit wait.** `agent_wait` uses a 3-minute supervision window by default (or a caller-chosen window); expiry returns transcript/activity evidence and never stops the child, so shell sleep/poll loops are unnecessary.
- **Fallback supervision.** When the root parent ends a turn with a background/resumed child still running, a 3-minute unsupervised clock starts. The reminder includes latest activity plus a short transcript tail and repeats after later idle turns until the parent waits, inspects, steers, stops, or the child settles.
- **Clarification path.** `ask_parent` lets a child yield when material information is missing; its immediate parent answers the same resident context with `agent_send`.
- **PiTTy bridge.** Spawn details expose a small direct-control directory for live inspection, steer, and stop. This does not emulate the old `pi-subagents` workflow runtime.

The only forced termination paths are an explicit `agent_stop`, a user/parent abort of a foreground tool call, model/process failure, or shutdown of the hosting Pi process.

## Agent profiles

Profiles are discovered from:

```text
~/.pi/agent/agents/*.md
<project>/.pi/agents/*.md
```

A project profile overrides a global profile with the same exact `name`.

Example implementer:

```markdown
---
name: implementer
description: Implements requested code changes and makes sure the affected code builds.
allowed_subagents:
  - explore
---

Implement the requested change. Keep scope focused on implementation.
Inspect directly relevant code, use an explore agent when broader codebase discovery is useful,
and make sure the affected component compiles/builds before reporting completion.
Do not perform a separate review or acceptance phase; the parent owns orchestration and review.
```

Example debugging duck:

```markdown
---
name: debugging-duck
description: Investigates a concrete failure and helps isolate its cause.
allowed_subagents:
  - explore
---

Diagnose the reported failure from evidence. Use an explore agent for broader repository discovery when useful.
Return the diagnosis and concrete next steps as normal text.
```

Example explorer:

```markdown
---
name: explore
description: Focused repository/codebase exploration.
allowed_subagents: []
---

Investigate the requested area and report the relevant evidence concisely. Do not modify files unless the task explicitly requires it.
```

Example reviewer:

```markdown
---
name: reviewer
description: Reviews a completed change and reports concrete findings to the parent.
allowed_subagents: []
---

Review the supplied change. Report concrete findings as normal text. The parent decides what to do with them.
```

With those profiles the delegation graph is:

```text
root -> any configured agent
implementer -> explore
debugging-duck -> explore
explore -> none
reviewer -> none
```

Nothing is hardcoded about those names. Change `allowed_subagents` in the Markdown files to change the graph.

## Migrating from `pi-subagents`

Do not leave the old `pi-subagents` runtime enabled when switching to this fork. A child is a normal Pi process and loads globally enabled extensions, so running both subagent runtimes at once can reintroduce the old runtime's prompt/budget policy inside children. PiTTy supports either runtime; they do not need to be active together.

```bash
pi remove npm:pi-subagents
pi install git:github.com/mistrjirka/pi-subagent
```

Existing `~/.pi/agent/agents/*.md` files can be reused. This runtime reads the Markdown body plus these frontmatter fields:

- `name`
- `description`
- `model`
- `thinking`
- `allowed_subagents`

Old orchestration fields such as `maxSubagentDepth`, `completionGuard`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, and `defaultContext` are ignored by this runtime. They do not become hidden limits.

Delegation is opt-in. Add the exact children a profile may launch; omitted means none. For the initial workflow discussed for this fork:

```yaml
# implementer.md
allowed_subagents: [explore]

# debugging-duck.md
allowed_subagents: [explore]

# explore/reviewer/impl-check profiles
allowed_subagents: []
```

The parent/root still owns orchestration and may launch any configured profile. In particular, the implementer should delegate only discovery to `explore`; implementation review remains a parent-owned phase.

## Model and thinking configuration

`agent_spawn` does **not** accept `model`, `thinking`, `tools`, timeout, or budget arguments.

Model/thinking can be set directly in an agent file:

```yaml
---
name: implementer
model: opencode-go/muse-spark-1.3-contributor
thinking: medium
allowed_subagents: [explore]
---
```

or centrally in Pi settings under `subagentProfiles`:

```json
{
  "subagentProfiles": {
    "agents": {
      "implementer": {
        "model": "opencode-go/muse-spark-1.3-contributor",
        "thinking": "medium"
      },
      "reviewer": {
        "thinking": "high"
      }
    }
  }
}
```

Both `~/.pi/agent/settings.json` and `<project>/.pi/settings.json` are read. Project agent settings override global agent settings. Settings override profile frontmatter for the fields they specify. If neither supplies model/thinking, the child inherits the parent Pi model/thinking level.

## Tools

### `agent_spawn`

```json
{
  "agent": "implementer",
  "prompt": "Implement issue #123. Relevant code is under src/foo.",
  "persistent": true,
  "run_in_background": true
}
```

Parameters:

- `agent` — exact configured profile name.
- `prompt` — concrete task. The stable role prompt comes from the profile.
- `label` — optional UI label; defaults to the profile name.
- `persistent` — keep the same child context resident after completion.
- `run_in_background` — root-only execution choice. `true` detaches and returns an agent id; false/omitted waits in foreground. Nested spawns are always foreground.

Nested agents do not get `run_in_background`; their parent waits for them directly.

### `agent_wait`

Wait for a direct child that is running in the background or has been resumed with `agent_send`:

```json
{ "agent_id": "@max" }
```

With no explicit timeout, `agent_wait` uses a **180-second supervision window**. It returns sooner if the child completes/fails/stops or reaches `ask_parent`. If the child is still running after 3 minutes, it returns a recent transcript/activity snapshot and asks the parent to check progress. The child keeps running. `timeout_seconds` changes only this wait window:

```json
{ "agent_id": "@max", "timeout_seconds": 150 }
```

When the 150-second window expires, the result says the child is still running and includes its latest activity plus a short recent transcript tail. Before calling `agent_wait` again, review that evidence and decide whether progress is HEALTHY, STALLED, or DRIFTING. If the short tail is insufficient, call `agent_inspect`. Only healthy progress should go straight into another wait; stalled/drifting work should be steered or stopped. `timeout_seconds: 0` is an immediate status snapshot. Omitting the field uses the 180-second default.

For root background/resumed children, the runtime also has a fallback supervision reminder: when the root parent ends its turn with a child still running, it starts a 3-minute unsupervised clock. If the parent has not resumed supervision before that window expires, the runtime injects a follow-up telling the parent to check the child and includes the latest activity. A new parent turn pauses the clock; if that turn ends with the child still running, a fresh 3-minute window begins. This is **not** a task timeout and never cancels the child.

Use `agent_wait` instead of shell `sleep`/poll loops.

### `agent_inspect`

Read a live direct child's state and recent Pi conversation transcript without changing the child:

```json
{ "agent_id": "@max", "max_messages": 12 }
```

The preferred transcript source is Pi RPC `get_messages`. If that RPC fails or is temporarily empty, monitoring falls back to the persisted child session and then to the live event stream, and reports which source was used instead of silently presenting an RPC failure as an empty transcript. The transcript includes user/parent follow-ups, assistant text, tool calls and tool results when available; the event fallback contains assistant/tool activity but cannot reconstruct past tool-result bodies. Raw thinking text is deliberately omitted from the monitoring view. `max_messages` defaults to 12 and may be 1–30.

Use `agent_inspect` when a wait-window snapshot is not enough to decide whether the child is making sensible progress. It is read-only and does not pause, steer, resume, or stop the child.

### `agent_send`

Send new instructions to a direct child. If it is idle/persistent or waiting after `ask_parent`, the same context wakes and continues.

```json
{
  "to": "@max",
  "message": "Reviewer found F1 and F2. Fix those and make sure it builds."
}
```

### `ask_parent`

Available only inside subagents:

```json
{
  "question": "The existing tests and task description disagree about this API behavior. Which behavior is authoritative?",
  "context": "test A expects X, while the task explicitly describes Y"
}
```

The child yields the current turn and remains resident. The immediate spawning agent receives the question and answers that exact child with `agent_send`. This works recursively: an explorer asks its implementer; the implementer can ask the root if it also cannot resolve the ambiguity.

Use this only for material ambiguity or missing information that would make guessing unsafe, not routine implementation decisions.

### `agent_stop`

Explicitly terminate a running or resident child.

## PiTTy integration

Each spawn reports these internal UI fields in tool details:

```text
runtime: profiled-subagents
profile
agentId
controlDir
statusPath
sessionPath
state
```


`status.json` mirrors the child's current state. PiTTy can write direct control requests under the reported `controlDir`:

```text
control/steer-requests/*.json
control/stop.json
```

The bridge supports direct **steer** and **stop**. It intentionally does not invent pause/resume semantics that Pi itself does not provide for these resident RPC children.

## Output behavior

The child itself returns normal assistant text. The runtime stores ordinary Pi session JSONL and attaches UI metadata separately.

Very large text may be preview-truncated when inserted into the **parent's context** using Pi's normal output protection, while the full child session/output remains available. This is context protection only; it never stops the child or limits how long it works.

## Development

The package requires the same modern Node/Pi stack as the upstream Everyx implementation. Run tests with Node 24+:

```bash
pnpm test
```

This fork preserves the original MIT license and credits the upstream implementation history.
