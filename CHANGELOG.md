# Changelog

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
