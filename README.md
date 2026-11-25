# @mistrjirka/pi-subagent

A small, profile-driven subagent runtime for [Pi](https://github.com/badlogic/pi-mono), forked from [`@everyx/pi-subagent`](https://github.com/everyx/pi-extensions/tree/master/packages/pi-subagent).

The runtime deliberately does very little orchestration. The **parent Pi decides the workflow**; this extension provides named child processes, communication, persistence, and explicit delegation rules.

## Design

- **No task caps.** No tool-call budget, token budget, turn budget, wall-clock deadline, concurrency ceiling, or nesting-depth ceiling.
- **No hardcoded workflow.** Roles come from the optional package bundle (enabled by default) plus Markdown files you own.
- **No fallback agent.** An unknown agent name is an error.
- **Plain-text results.** A subagent finishes with ordinary assistant text. There is no required JSON/Zod/structured-output schema.
- **Optional tool groups.** Existing configurations keep normal Pi tools. Profiles/settings can select optional groups to reduce context while retaining enabled workspace, history, and parent-communication tools. This is not a sandbox.
- **Explicit delegation.** A child may spawn only exact agent names listed in its profile's `allowed_subagents`. Omitted means none.
- **Persistent workers.** A child can stay resident after finishing and be continued with `agent_send` in the same context.
- **Explicit wait.** `agent_wait` uses a 150-second supervision window by default (or a caller-chosen window); expiry returns compact activity, new tool errors and tracked edited files, and never stops the child.
- **Fallback supervision.** When the root parent ends a turn with a background/resumed child still running, a 150-second unsupervised clock starts. The reminder includes latest activity and new tool errors and repeats after later idle turns until the parent waits, inspects, steers, stops, or the child settles.
- **Escalation path.** `ask_parent` lets a child yield on material ambiguity, a non-obvious diagnosis, or a material implementation decision; its immediate parent answers the same resident context with `agent_send kind=answer`.
- **PiTTy bridge.** Spawn details expose a small direct-control directory for live inspection, steer, and stop. This does not emulate the old `pi-subagents` workflow runtime.

The only forced termination paths are an explicit `agent_stop`, a user/parent abort of a foreground tool call, model/process failure, or teardown of the hosting Pi session (including new/resume/fork transitions).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime service boundaries and typed status protocol.

## Agent profiles

Profiles are discovered in this order:

```text
bundled profiles shipped with this package
~/.pi/agent/agents/*.md
<project>/.pi/agents/*.md
```

A later source overrides an earlier one by the exact `name` field: a global
custom profile wins over a same-name bundled profile, and a project custom
profile wins over both. User profiles are always loaded; the `builtinAgents`
setting below only selects which bundled profiles ship alongside them.

### Bundled profiles

With no setting, these three core profiles are available everywhere:

| Profile | Delegation | Role |
| --- | --- | --- |
| `explore` | none | Read-only first-pass investigation of an unfamiliar area, reported with concrete evidence. |
| `implementer` | `explore` | Carries out a scoped implementation task and runs a focused check that it holds together. |
| `debugging-duck` | `explore` | Read-only evidence-based diagnosis of a reported failure, with concrete next steps. |

Setting `builtinAgents` to `"all"` adds these six read-only profiles (none of
them delegates to another agent):

| Profile | Role |
| --- | --- |
| `feasibility` | Research into whether a proposed approach can work, backed by project sources. |
| `implementation-review` | Direct review of a completed change, reporting concrete actionable findings. |
| `impl-check-behavior` | Review of the observable behavior of a change against its stated intent. |
| `impl-check-contracts` | Review that a change honors the interfaces and data shapes it touches. |
| `impl-check-design` | Review of how a change fits the surrounding structure and conventions. |
| `impl-check-runtime` | Review of the runtime consequences of a change, from startup to failure modes. |

The bundled prompts are written to apply to any kind of repository — source,
configuration, documentation, or other material. They set no model or provider;
model and thinking resolve exactly as for custom profiles (see below).

### Choosing the bundle: `builtinAgents`

Under `subagentProfiles` in `~/.pi/agent/settings.json` or
`<project>/.pi/settings.json`:

| Value | Effect |
| --- | --- |
| omitted or `"default"` | Load the bundled `explore`, `implementer`, and `debugging-duck` profiles. |
| `"none"` | Load no bundled profile — only the global and project custom Markdown profiles. |
| `"all"` | Load the default trio plus all six extended bundled profiles. |

Any other value is ignored — the discovery result carries a warning naming
the settings file and the invalid value. The `"default"` bundle applies
only when no valid scope supplies a mode. Project `builtinAgents` overrides
global `builtinAgents`, matching the existing scope convention for profile
settings.

Custom-only setup (no bundled profiles, just your own files):

```json
{
  "subagentProfiles": {
    "builtinAgents": "none"
  }
}
```

Full bundle:

```json
{
  "subagentProfiles": {
    "builtinAgents": "all"
  }
}
```

Overriding a bundled profile with your own file keeps the rest of the bundle.
For example, to replace the bundled `explore` globally, add
`~/.pi/agent/agents/explore.md` with the same `name: explore` — your prompt
and `allowed_subagents` win for that name, and the other bundled profiles keep
loading. A project file at `<project>/.pi/agents/explore.md` would in turn win
over the global one.

### Custom profiles

Your own Markdown profiles live in the two user locations from the discovery
order above. This runtime reads the Markdown body plus these frontmatter fields:

- `name`
- `description`
- `model`
- `thinking`
- `allowed_subagents`
- `toolGroups` (optional)

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

With the default bundle plus that custom reviewer, the delegation graph is:

```text
root -> any configured agent
implementer -> explore
debugging-duck -> explore
explore -> none
reviewer -> none
```

Nothing is hardcoded about the custom names. Change `allowed_subagents` in the Markdown files to change the graph.

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

## Optional tool groups

Set `toolGroups` in profile frontmatter, or in `subagentProfiles.defaults` / `subagentProfiles.agents.<name>` settings. Precedence matches model/thinking: project agent settings, global agent settings, profile, project defaults, then global defaults. Omitted preserves ordinary tools. An empty list selects only required tools. Invalid selected settings fail instead of silently exposing all tools.

| Group | Optional tools |
| --- | --- |
| `discovery` | `codegraph_*`, `semble_*` |
| `web` | `web_search`, `source_check`, `fetch_content`, `get_search_content` |
| `browser` | `mcp__playwright*`, `browser_*` |
| `mcp` | `mcp`, `mcp__*` |
| `memory_write` | `memory_add`, `memory_replace`, `memory_remove` |
| `tool:<exact_name>` | One other tool already enabled in Pi |

For example, `toolGroups: [discovery, web]` keeps repository discovery and web research while hiding other optional schemas. Required tools are available only if Pi already enabled them: `read`, `bash`, `edit`, `write`, `code`, `bash_watch`, `bash_output`, `bash_tasks`, `bash_kill`, `session_search`, `user_artifact`, `memory_search`, `memory_read`, `agent_send`, and `ask_parent`. Profiles with `allowed_subagents` also retain child-management tools. Leaf profiles omit those tools and their instructions. Recovery remains root-only.

Selection changes the active registry and model-visible tool schemas. It does not grant tools disabled by another extension and does not restrict what shell code can do. Each spawned profile selects its own groups; nested workers do not accidentally inherit their parent's selection. Root sessions are unchanged.

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

Address `prompt` to the selected child: task, scope, constraints, evidence, and required result. Resolve parent-only selection, recovery and configuration before the call. Omit `resume_id` for a fresh context. Keep substantive requirements such as independent verification or avoiding a rejected approach in the task.

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
- `run_in_background` — root-only execution choice. Omitted or `true` detaches and returns an agent id; `false` waits in foreground. Nested spawns are always foreground.
- `resume_id` — root-only recovery id returned by `agent_recover` for the same project, branch, role and model. Requires a **new prompt** and keeps the restored child persistent.

Nested agents do not get `run_in_background`; their parent waits for them directly.

When `pi-one-round-compaction` 0.4.4+ is installed, a checkpoint also captures a small snapshot of direct active children. It includes their `@id`, running/waiting/idle state, label, and brief task preview. This roster is counted against the same post-compaction token target. No full child conversations or tool results are copied. The snapshot can become stale after compaction, so use `agent_list` to refresh it.

### `agent_list` (current Pi process, including after compaction)

Call `agent_list` with `{}` to list running, waiting, resident/idle, and recently finished *direct* children with their agent IDs. This is read-only and does not inspect their conversations, start a worker, or consume a queued result. Use it after a context compaction or when the parent no longer remembers which agents are active. A parent compaction does **not** stop its children; it only replaces older parent conversation history.

After the parent Pi process exits or restarts, the live roster is gone. Use `agent_recover` instead to find recorded `persistent: true` child sessions in the same project and Git branch. Nonpersistent exited workers cannot be recovered.

### `agent_recover` (root-only, after a restart)

Persistent children now leave a small, private recovery record under
`~/.pi/agent/subagent-recovery/` (or the configured Pi agent directory).
It stores the project path, Git branch, profile, model, label and **existing**
child session path. The conversation stays in `subagent-sessions/*.jsonl`.
No prompts, credentials or transcripts are copied into the recovery record.
Only workers started with `persistent: true` get recovery records.

If Pi quits or restarts, the old worker process exits but its session survives.
When you reopen the **same project and branch**, list recorded sessions:

```json
{}
```

Call the `agent_recover` tool with those parameters. It returns the recovery
ids and whether each worker is recoverable or still owned by a live Pi process.
To continue a prior implementation context, explicitly spawn a *new process*
from its saved transcript, with a fresh task prompt:

```json
{
  "agent": "implementer",
  "resume_id": "<id returned by agent_recover>",
  "prompt": "Continue this same assignment. Read the current intent and plan; recheck the working tree and decisions before editing.",
  "persistent": true
}
```

The recovered process loads the earlier Pi conversation before accepting the
new prompt. The extension verifies the loaded session path and a nonzero message count
from Pi session statistics **before** sending any new task. It does not fetch
the full transcript for this check. A missing/invalid transcript,
changed project, branch, profile or model, or an active owner prevents recovery.
A deliberate `agent_stop` permanently retires the recovery id. A dead parent
leaves a reclaimable lease, and normal session shutdown releases its lease.

Recovery never resumes unfinished edits or starts a model automatically.
A parent must decide that the old task boundary still applies and include any
new requirements. Existing contexts created **before this version** have no
recovery records. Reuse saves exploration context, but may trigger compaction
for large histories. Do not use one recovery id concurrently in two Pi sessions.

### `agent_wait`

On Pi versions with the accepted `input_queued` hook, a user steering message in PiTTy or the terminal immediately releases active waits in that session. The result reports `interruptedByUser: true` and the current child state. Child agents continue running, and Pi delivers the queued input at its next boundary. Follow-up messages and extension-generated input keep their existing delivery behavior. Older Pi versions without this hook retain the normal wait behavior. Saved conversations need no migration.

Wait for a direct child that is running in the background or has been resumed with `agent_send`:

```json
{ "agent_id": "@max" }
```

With no explicit timeout, `agent_wait` uses a **150-second supervision window**. It returns sooner if the child completes/fails/stops or reaches `ask_parent`. If the child settled earlier in the current parent turn, `agent_wait` consumes that cached settlement and suppresses the otherwise-pending completion/question notification, so the same result is not delivered again after the turn. If the child is still running after 150 seconds, it returns latest activity, tool-result and error counts, a bounded latest assistant update, and tracked edited files since the last check. No transcript is injected. The child keeps running. `timeout_seconds` changes only this wait window:

```json
{ "agent_id": "@max", "timeout_seconds": 150 }
```

When the 150-second window expires, the result says the child is still running and includes its compact progress status, without copying tool arguments, successful tool outputs or thinking into the parent context. Compare new evidence with the assigned scope and last correction to judge whether the child is making real progress. Read recent evidence with `agent_inspect` only to resolve a problem or decision, and use its full mode when needed. If progress remains aligned, wait again without reassurance messages, document updates, or repeated audits. Inspect or steer with `agent_send` for a concrete blocker, scope drift, repeated failure, or necessary coordination. Stop the child when needed. A timeout or long-running command alone is not a stall. Use completion results already delivered rather than fetching them again. `timeout_seconds: 0` is an immediate status snapshot. Omitting the field uses the 150-second default.

For root background/resumed children, the runtime also has a fallback supervision reminder: when the root parent ends its turn with a child still running, it starts a 150-second unsupervised clock. If the parent has not resumed supervision before that window expires, the runtime injects a follow-up telling the parent to check the child and includes the latest activity. A new parent turn pauses the clock; if that turn ends with the child still running, a fresh 150-second window begins. This is **not** a task timeout and never cancels the child.

Use `agent_wait` instead of shell `sleep`/poll loops when waiting for subagents. Ordinary external processes may use their process/job wait mechanisms.

### `agent_inspect`

Recent previews have a 2,200-character total budget for both resident and archived children. They do not acknowledge final delivery or consume tracked edited-file deltas. Use `agent_wait` to receive the final result. Repeated waits report that the result was already delivered. A full inspection acknowledges delivery only when it includes the complete settled result.

Use `{"agent_id":"@max","mode":"diagnostics"}` only to diagnose context construction. This reports persisted system-section character counts, registered tool count, message roles, and hidden custom-message types. It does not print message bodies or reasoning. It uses an independent bounded read of the first context window and does not claim to show the provider's actual wire input.


Read a direct child's state and recent compact evidence without changing the child:

```json
{ "agent_id": "@max" }

```

Default `mode: "recent"` returns newest unread evidence first, excluding thinking and echoed parent instructions. It keeps short tool arguments and result excerpts, assistant updates and errors. The transcript budget is 2,200 characters; `max_messages` defaults to 8 (1–30). Wait and inspect share only the edited-file and progress counters. For detailed history, call:

```json
{ "agent_id": "@max", "mode": "full", "max_messages": 12 }
```

Full mode has an independent, append-ordered cursor and returns the previous detailed transcript (up to 20,000 characters, with thinking where available). Compact inspection never consumes full evidence. Full pages use persisted session entries first, falling back to Pi RPC `get_entries(since)` when needed. Full `max_messages` defaults to 12. A partial append stays unread until its newline arrives. Read failures are reported without consuming full history.

Edited-file tracking uses successful direct `edit`/`write` results and successful nested calls reported by `code`. Files are deduplicated per child and per inspection interval; the total is scoped to the current child process, including its resident follow-ups. A write may be a new file or an overwrite. Shell commands and tools without attributable structured write evidence may change other files; those writes are not guessed from shared Git state. Full traces remain in the child session and live UI. Completed children remain inspectable through their cached result. Reading that completed result acknowledges its pending notification. Partial transcript pages do not acknowledge unseen results. Unread completions are delivered at a safe parent tool/model boundary. **If the same child already sent a substantive `agent_send` update visible to the parent during its current task**, the completion is appended as a visible session notification without starting another model turn. Otherwise the original proactive wake-up remains. A message still queued for delivery or a diagnostic ping does not suppress the wake-up. Explicit `agent_wait`/`agent_inspect` consumption still acknowledges the final result. `ask_parent` remains urgent and immediately delivered. The completion always remains available in session history and the agent inspector.

Notification usage separates **cumulative tokens (including cache)** across requests, **generated tokens**, and **estimated context tokens**. Context is omitted when Pi reports it unknown, such as immediately after compaction.

Use `agent_inspect` when a compact wait status is not enough. It is read-only with respect to the child: it advances only the parent-side transcript cursor and does not pause, steer, resume, or stop the child.

### `agent_send`

Send new instructions to a direct child. If it is idle/persistent or waiting after `ask_parent`, the same context wakes and continues. A running child reports the message as **queued**; an idle child reports it as **accepted**. These acknowledgements confirm prompt acceptance, not that the child has acted on the message.

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

Use this for material ambiguity/missing information or when unexpected evidence invalidates the route and resolving it requires non-obvious diagnosis or a material decision. Include the smallest safe reproduction or exact steps, decisive evidence, what requirement or route is blocked/invalidated, and the specific parent decision needed; routine implementation choices and obvious local fixes stay with the child.

### `agent_stop`

Stopping ends execution and removes the resident process. Existing file changes remain. Steer recoverable mistakes first; inspect existing changes before deciding to start a replacement.

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

`events.jsonl` in the same directory is the append-only live tail for external readers. It is the only channel that carries a **background** child's progress, because the live tool card exists for foreground spawns only. One JSON object per line:

```text
{"v":1,"seq":1,"ts":1789657746999,"runId":"max","messageSeq":1,"kind":"thinking","blockId":"think-0","text":"let me check"}
{"v":1,"seq":2,"ts":1789657747000,"runId":"max","messageSeq":1,"kind":"text","blockId":"text-1","text":"The build passes."}
{"v":1,"seq":3,"ts":1789657747000,"runId":"max","messageSeq":1,"kind":"tool_start","toolName":"bash","toolCallId":"call-3"}
{"v":1,"seq":4,"ts":1789657747000,"runId":"max","messageSeq":1,"kind":"tool_end","toolName":"bash","toolCallId":"call-3"}
```

`kind` is `thinking`, `text`, `tool_start` or `tool_end`. Tool start/end describe actual execution, not model argument generation. Starts include argsPreview and an explicit bash timeoutSeconds when supplied; ends include isError. status.json exposes currently executing tools (cleared by execution-end events or the authoritative persisted `toolResult` message) through optional activeTools entries (id, name, start time, explicit timeout). A status heartbeat confirms the bridge is alive, not that work has progressed. `messageSeq` is the 1-based assistant-message sequence for the child run; together with `blockId` it gives external readers a stable turn-local identity even though content indexes such as `think-0` repeat on later assistant messages. A `thinking`/`text` line carries an incremental `text` chunk plus that turn-local `blockId`. Writes are coalesced — flushed on a kind change, every 250 ms, or past roughly 4 KB — and text stops at a 2 MB cap while tool rows keep flowing, so no reader should assume `seq` is contiguous. Readers must ignore a torn trailing line and unknown fields. The file is created with the run and removed with the `controlDir`, so its absence after a Pi restart is expected rather than an error.

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

### Completion output and acceptance

`completed` describes turn settlement. The runtime reports `taskOutcome: "not_assessed"`; the parent checks the assignment against the evidence. Children return ordinary text, with no required JSON outcome or compulsory tool call. Parent-visible results preserve up to 8,000 characters from the beginning and end. When truncated, a private full-output file and the persisted session retain the complete evidence. Repeated delivery of the same result reuses its artifact reference.
