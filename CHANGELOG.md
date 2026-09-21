# Changelog

## 0.5.5 — stable live transcript turn identity

- Tag `events.jsonl` thinking/text/tool records with an additive 1-based `messageSeq` derived from Pi's real assistant `message_start`/`message_end` lifecycle. Repeated block ids such as `think-0` are now distinguishable across assistant turns without using content as identity.
- Flush the live-stream buffer at assistant message boundaries so adjacent turns cannot coalesce merely because they reuse the same content index.
- Keep the wire format backward compatible: `v` stays `1`, `messageSeq` is optional, and readers that ignore unknown fields continue to work.
- Add regressions for assistant lifecycle interpretation and repeated `think-0` blocks across separate messages.

## 0.5.4 — consumed completion notifications

- Prevent a late duplicate completion notification when a child settles during an active parent turn and the parent then consumes the cached result with `agent_wait`. Completion/question announcements now stay pending until the parent `agent_settled` event and are cancelled if `agent_wait` consumes that settlement first.
- Apply the same rule to `ask_parent` questions and completed persistent follow-up turns, so a parent cannot answer/read a cached child result and then receive the stale notification afterward.
- Flush deferred announcements on `agent_settled`, not `agent_end`; Pi may still retry or compact after `agent_end`.
- Re-check a child's live registry/status after asynchronous supervision transcript collection so a child that finishes during that await cannot emit a stale "still running" reminder.
- Add regressions for cached completion consumption, deferred single delivery, and cached `ask_parent` consumption.

## 0.5.3 — full thinking in supervision traces

- Show the child's actual plaintext thinking in monitoring transcripts instead of collapsing every reasoning block to `[thinking]`.
- Apply the same transcript policy to `agent_inspect`, timed/default `agent_wait` snapshots, and the 3-minute fallback supervision reminder because all three share the same formatter.
- Preserve the existing evidence selection exactly: transcript message/tool rows are budgeted against the old compact `[thinking]` form, then thinking text is expanded afterward, so long reasoning cannot evict tool calls or tool results from the selected window.
- Do the same for the live-event fallback: event count and compact character selection stay unchanged while retained thinking markers expand to their plaintext content.
- Add regressions with 10–20k-character thinking blocks proving tool/tool-result counts remain unchanged.

## 0.5.2 — visible subagent thinking text

- Preserve plaintext `thinking_delta` content in the in-memory `RenderEvent` fold instead of reducing it to a marker. Consecutive chunks accumulate into one growing thinking row.
- Foreground `agent_spawn` cards now render the actual thinking text, and background/resident widget rows show the latest accumulated thought instead of only `Thinking...`.
- Keep supervision/agent-inspect context behavior unchanged: monitoring summaries still collapse reasoning to `[thinking]` rather than copying raw reasoning into the parent model's context.
- Add regressions for thinking accumulation and widget rendering while preserving the generic marker fallback before text arrives.

## 0.5.1 — stop suppression race + whole-tree id uniqueness

- Close the stop/complete race in `stopAndRemove`: the stopped flag is now recorded synchronously before awaiting transport shutdown, so a completion landing mid-stop observes `stoppedByControl` and stays silent instead of emitting a notification for an agent the user just stopped.
- Guarantee whole-tree agent-id uniqueness: the spawner passes its ancestor id chain (`PI_SUBAGENT_ANCESTOR_IDS`) through the existing child identity env, and each child registry seeds its used-name set from it — a nested grandchild can no longer re-roll an ancestor or cousin name. Consumers rendering the whole tree keyed by bare id (PiTTy does) no longer see two different agents under one id. Absent or malformed env values keep exactly the previous behavior.
- Correct the `name-gen` header, which previously claimed cross-process collision was harmless.

## 0.5.0 — portable bundled agent profiles

- Ship nine package-owned Markdown profiles under `builtin-agents/core` and
  `builtin-agents/extended`, included in the published artifact via the
  `package.json` `files` entry so they survive packing.
- Load bundled profiles first, then global user profiles, then project user
  profiles: a custom profile at either user location overrides a same-name
  bundled profile, and a project custom profile overrides both.
- Add the `subagentProfiles.builtinAgents` setting with three exact string
  modes: omitted or `"default"` loads bundled `explore`, `implementer`, and
  `debugging-duck`; `"none"` loads no bundled profile (custom-only mode);
  `"all"` loads the default trio plus bundled `feasibility`,
  `implementation-review`, `impl-check-behavior`, `impl-check-contracts`,
  `impl-check-design`, and `impl-check-runtime`. Invalid values are ignored
  with a catalog warning naming the settings file; the default applies only
  when no valid scope supplies a mode. Project `builtinAgents` overrides
  global `builtinAgents`.
- Keep existing behavior otherwise: malformed-file warnings, exact
  `allowed_subagents` enforcement, and model/thinking precedence are
  unchanged, and the bundled prompts set no model or provider.

## 0.4.7 — plain supervision wording

- Replace the HEALTHY / STALLED / DRIFTING taxonomy in the supervision texts with a plain progress check: is the child making real progress on its task, and if it looks stuck, is repeating itself, or has wandered off the task, steer it with `agent_send`, inspect it, or stop it.
- The mechanism is unchanged: the 150-second cadence advice, the 180-second default window, `timeout_seconds: 0` snapshots, the self-contained checkpoint (recent activity plus up to ~10k characters of transcript), the `subagent-supervision` reminder after three unsupervised minutes, and `agent_inspect` for older history all behave exactly as before.
- A test pins the absence of those three words in the reader-facing strings together with the presence of the concrete signals and actions, so the taxonomy cannot creep back.

## 0.4.6 — local transcript times

- Stamp supervision transcript lines with the system's local wall clock plus a relative age, e.g. `[17:42:03 · 12s ago] assistant: …`. Times use local date getters only, so a machine at UTC+2 shows `17:42:03` for an instant stored as `15:42:03Z`; a line from another local day shows `MM-DD HH:MM` instead. An absent or unusable time renders exactly as before, with no brackets.
- Stamp all three transcript sources: live RPC messages, the persisted child-session fallback, and the in-memory event trace. The persisted path previously discarded the record's own `timestamp`, so after an RPC failure the transcript carried no times at all.
- Add an optional `ts` to the in-memory `RenderEvent` fold so the event-trace path can be stamped too. Additive only — the card, widget, preview and tree renderers ignore it, and no wire shape changed: `status.json`, `control/*`, `events.jsonl` and the tool/notification details are untouched.

## 0.4.5 — stopped agents stop reporting

- Stop leaking a live status heartbeat when a resident agent is stopped. `agent_stop` on a persistent agent that had already completed left that agent's control bridge running, so `status.json` kept reporting `idle` with a fresh `updatedAt` for the entire life of the hosting Pi process — a dead child looked permanently live to any external reader, and the bridge kept a 200 ms timer plus two status writes per tick alive with it.
- Record an explicit stop as a terminal state: `AgentProcess.markStopped()` flags the stop as user-controlled and sets the reported status to `stopped` (idempotent, never overwrites `failed`), and `AgentRegistry.stopAndRemove()` applies it. The control bridge's existing terminal check then clears the timer, flushes the event stream and writes the final `stopped` status.
- The normal completion path is deliberately untouched: a child that completes or fails still reports `completed`/`failed` with its bridge wound down, and a resident agent that is merely left idle still heartbeats `idle` so it stays addressable.

## 0.4.4 — live child event stream

- Publish `<controlDir>/events.jsonl`, an append-only live tail carrying a running child's thinking chunks, assistant text chunks and tool rows — including for **background** spawns, which previously published no live progress at all because the live card channel only existed for foreground ones.
- Capture the reasoning chunk text, which event interpretation used to reduce to a content-less marker. It is carried additively on the interpreted event and reaches the stream, while the in-memory card and widget rows stay exactly as they were.
- Keep the writer bounded: coalesced flushes (on a kind change, every 250 ms, or past ~4 KB), a 2 MB cap that sheds text while tool rows continue, no per-token syscalls and no `fsync`.
- Additive and backwards compatible: `status.json`, `control/*`, the spawn tool details and the completion notification keep their existing shapes, so a reader that does not know the new file is unaffected.

## 0.4.3 — self-contained wait supervision

- Make timed `agent_wait` checkpoints return a compact recent activity trail plus up to ~10k characters of recent transcript.
- Keep `agent_inspect` as a deeper-history escape hatch rather than a normal step between waits.

## 0.4.2 — reliable supervision transcript

- Stop swallowing `get_messages` RPC failures as empty transcripts.
- Fall back from live RPC to the persisted child session and then to the live event trace.
- Make timed wait/reminder output require a HEALTHY / STALLED / DRIFTING supervision decision before another wait.

## 0.4.1 — default supervised wait

- Make `agent_wait` without `timeout_seconds` return after the default 180-second supervision window instead of blocking indefinitely.
- The default expiry returns the same recent transcript/activity check and never stops the child.

## 0.4.0 — live transcript inspection

- Add read-only `agent_inspect` backed by Pi RPC `get_messages` for recent live child transcript monitoring.
- Include short transcript tails in timed `agent_wait` supervision results and 3-minute fallback reminders.
- Include assistant text, tool calls, user follow-ups and tool results while omitting raw thinking text from monitoring output.

## 0.3.0 — supervised waits

- Add optional `timeout_seconds` to `agent_wait`; expiry returns latest child activity without stopping the child.
- Add a 3-minute fallback supervision reminder that starts when the root parent ends a turn with a background/resumed child still running.
- Active waits pause the reminder; a wait-window timeout restarts it, and child settlement/stop clears it.
- Keep the recommended active implementer supervision cadence at 150 seconds while preserving uncapped task lifetime.

## 0.2.0 — explicit wait and execution defaults

- Add `agent_wait` for blocking on a direct background/resumed child without a framework timeout.
- Suppress duplicate completion notifications when an active `agent_wait` consumes the settlement.
- Keep explicit stop/cancel behavior deterministic and remove any need for shell sleep/poll loops.

## 0.1.1 — symlink profile discovery

- Discover Markdown profiles installed as symlinks, including the wiki `just link pi` layout.
- Ignore broken profile symlinks without hiding other valid profiles in the same directory.

## 0.1.0 — profiled fork

- Add Markdown agent profiles with project-over-global overrides and exact `allowed_subagents` delegation.
- Remove model/thinking/tool/time/budget controls from `agent_spawn`; model/thinking resolve from settings or profiles.
- Add `ask_parent` with same-context resume through `agent_send`.
- Remove task-level tool/token/turn/time/concurrency/depth caps.
- Add direct PiTTy status/steer/stop integration while preserving ordinary Pi sessions.

### Upstream history

## [1.3.7](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.6...pi-subagent-v1.3.7) (2026-09-11)


### Bug Fixes

* **pi-subagent:** cascade widget-row removal down the spawn subtree ([ebe4f59](https://github.com/everyx/pi-extensions/commit/ebe4f59b4123d44788c22c09ba122cd7216fa476))
* **pi-subagent:** route a woken agent's output to the widget ([092f793](https://github.com/everyx/pi-extensions/commit/092f793a97d139d51eff7f1de91692ceebc2e362))
* **pi-subagent:** stop the completion card reading as a spawn ([a6cf5c4](https://github.com/everyx/pi-extensions/commit/a6cf5c40eb8bf9c9362c7fe549a773c59ee4a5a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.2.0

## [1.3.6](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.5...pi-subagent-v1.3.6) (2026-09-01)


### Bug Fixes

* **pi-subagent:** agent_spawn title → required label — short, single name end-to-end ([963d04f](https://github.com/everyx/pi-extensions/commit/963d04f483003a31cb07702272a0f679456c56df))
* **pi-subagent:** persistent foreground widget row registers as idle, not done ([8499866](https://github.com/everyx/pi-extensions/commit/849986608ea3e380d1e2e8bbb492f0c3a361f47f))
* **pi-subagent:** rot sweep — dead PI_SUBAGENT_PARENT + steer leftovers, stale docs/SPEC, files += README.zh.md ([f2ef35f](https://github.com/everyx/pi-extensions/commit/f2ef35fecfc6af9b5feae653766d72ceb7c71cc1))
* single-source the display surface — counterParts, agentTitle, iconForStatus ([d698d29](https://github.com/everyx/pi-extensions/commit/d698d29b42d6af27fb445cd39353ed749fb45c7c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.2

## [1.3.5](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.4...pi-subagent-v1.3.5) (2026-08-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.1

## [1.3.4](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.3...pi-subagent-v1.3.4) (2026-08-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.1.0

## [1.3.3](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.2...pi-subagent-v1.3.3) (2026-08-30)


### Bug Fixes

* correct display bugs an LLM reader would trust ([3ee8501](https://github.com/everyx/pi-extensions/commit/3ee8501e304468864f359e017d9008643530ffa9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.0.3

## [1.3.2](https://github.com/everyx/pi-extensions/compare/pi-subagent-v1.3.1...pi-subagent-v1.3.2) (2026-08-29)


### Bug Fixes

* **release:** migrate to release-please for correct workspace/catalog resolution ([e3b51e4](https://github.com/everyx/pi-extensions/commit/e3b51e421d7679f7c00739646f97d770dd0ff2aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @everyx/pi-ui bumped to 1.0.2
