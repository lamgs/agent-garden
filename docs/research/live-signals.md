# Live signals: what Agent Garden can observe while agents run

Status: research note, 2026-10-08. Not yet a contract. Feeds a future "live garden" milestone.
Scope: which sources expose a person's Claude Code agent system **live** (not after the fact), how
fast, at what privacy cost, and a normalized event model + per-agent state machine on top of them.

## 0. Summary and recommendation

| Source | Default? | Latency | Changes user settings? | Gives |
|---|---|---|---|---|
| Transcript tailing (`~/.claude/projects/**.jsonl`, `subagents/`) | **Default** | 30–70 ms after each content block / tool result | No | Almost everything: prompts, tool start/end, errors, subagent fan-out, hooks summary, compaction, harness |
| Session registry (`~/.claude/sessions/<pid>.json`) | **Default** | On change (status flips) | No | Per-process `status` `busy`/`idle`/`waiting`/`shell`, `waitingFor`, `kind`, `name`, `pid` |
| Process liveness (`kill(pid, 0)` on registry `pid`) | **Default** | Poll | No | Session alive vs. crashed/closed |
| Hooks (`settings.json` → local script → 127.0.0.1) | **Opt-in** | ms, synchronous with CC | **Yes** (writes `~/.claude/settings.json`) | Authoritative `PermissionRequest`, `Notification(permission_prompt/idle_prompt)`, `Stop`, `SubagentStart/Stop`, `PreCompact`, `SessionEnd`, `PostToolUseFailure` |
| OpenTelemetry (OTLP → local collector in Garden) | Opt-in | Export interval (logs ~s, metrics default 60 s) | Env vars only | Cost/token/tool/decision events, spans incl. `claude_code.tool.blocked_on_user` |
| Statusline command | Opt-in | Each statusline refresh | Yes (`statusLine` setting; only one per user) | Context-window %, cost, rate limits, prompt-cache health |
| `--output-format stream-json` / Agent SDK | Only for runs Garden launches | Token-level | No (it's the caller's process) | Exact `session_state_changed`, `task_*`, `hook_*`, `api_retry`, `result` |

**Recommendation.** Ship the live view on **transcript tailing + the session registry + pid liveness**.
That needs no settings changes, sends nothing anywhere, and covers every state except "waiting for
permission" with certainty. Fill that gap with the registry's `status: "waiting"`, which is the
interactive CLI's own flag, and fall back to the timer heuristic in §4.3 when it is missing.
Hooks are an **opt-in** "instant + exact" upgrade with an explicit consent screen, a backup of
`settings.json`, and one-click uninstall (Pixel Agents' pattern, §5). OTel and the statusline are
optional enrichments. Stream-json is for sessions Garden itself launches (evals, hill-climbing).

## 1. Method and evidence tags

Container: Claude Code **v2.1.293**, entrypoint `remote_desktop`, Linux. This note was written by a
background subagent of a live session. I watched the parent transcript, my own subagent transcript,
and sibling subagent transcripts grow with a 50 ms poller (size delta, newline termination, and
parsed record types per write).

Tags: **[observed]** seen live in this container. **[bundle]** string or zod schema extracted from the
installed CLI binary (`strings /opt/claude-code/bin/claude`), which is ground truth for this version
but not a stability promise. **[docs]** official docs. **The official doc hosts (code.claude.com,
docs.claude.com) were blocked by this container's egress policy again**, so doc URLs are cited as the
canonical references and their content was cross-checked through web search excerpts. **[PA]** Pixel
Agents 1.4.1 npm bundle (`pixel-agents` on npm, repo `pixel-agents-hq/pixel-agents`). **[COM]**
community source.

Canonical docs (verify against these before shipping):
- Hooks reference: https://code.claude.com/docs/en/hooks; guide: https://code.claude.com/docs/en/hooks-guide
- Agent SDK hooks: https://platform.claude.com/docs/en/agent-sdk/hooks
- Monitoring / OpenTelemetry: https://code.claude.com/docs/en/monitoring-usage
- Status line: https://code.claude.com/docs/en/statusline
- Headless / stream-json: https://code.claude.com/docs/en/headless
- Subagents: https://code.claude.com/docs/en/sub-agents; agent teams: https://code.claude.com/docs/en/agent-teams
- Settings: https://code.claude.com/docs/en/settings

No real content appears below. Only record shapes, field names, and timings.

## 2. Live signal sources

### 2a. Transcript tailing [observed unless tagged]

**Files.** Main thread `~/.claude/projects/<slug>/<sessionId>.jsonl`. Subagents
`~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json`
(`agentType`, `description`, `toolUseId`, `spawnDepth`, `requestShape` e.g. `background`,
`requestNonInteractive`). Background subagents are still written under the parent session dir.

**Flush behaviour.**
- Appends are **whole lines, newline-terminated, per write**. In ~60 observed writes the poller never
  saw a partial line. A write can carry 1–3 lines (for example a `tool_result` + `total_tokens_reminder`
  attachment, or `tool_use` + an immediate `tool_result` for an in-process tool like ToolSearch).
  The tailer must still buffer a trailing fragment, because Node `appendFile` gives no atomicity
  guarantee for large lines (single lines here reach ~5 KB, and tool results can be much larger).
- Lag from the record's `timestamp` to bytes on disk is **30–70 ms**.
- **Assistant content is written per completed content block, not per token.** A `thinking` block line
  appears when the block finishes, then `text`, then each `tool_use`, each as its own line sharing
  `message.id` (the `apiBlockIndex` field gives the order). No line is written while the model is
  generating. Gaps of 3–27 s between a `tool_result` and the next assistant line are model time.
- **The `tool_use` line is on disk before the tool executes.** Probe: a Bash command that read its own
  transcript found its own `tool_use` as the last line, timestamped about 0.9 s before the command
  started (that interval includes the permission classifier).
- `stop_reason` is already final on every line of a main-thread message (`tool_use` or `end_turn`, even
  on the `thinking` line). So lines are emitted after the message completes, or at least after
  `message_delta`. **In subagent files `stop_reason` is `null` on every line** (stream-start usage, see
  docs/sources.md), so it cannot mark a subagent's turn end.

**Tool call pairing.** The assistant line has a `tool_use` block (`id`, `name`, `input`, `caller`) plus
a line-level `wireToolInputs: {<tool_use_id>: input}`. The result is a `user` line with
`message.content[0].type = "tool_result"` and `tool_use_id`, `is_error`, a top-level `toolUseResult`
(object, or a string on error starting `Error: `), `sourceToolAssistantUUID`, and
**`permissionDecision: {decision, source, reasonType}`**. Values seen: `decision: "accept"`,
`source: "config"`, `reasonType` ∈ {`classifier`, `rule`, `mode`}. This tells us after the fact
whether a call was auto-approved by a rule, the auto-mode classifier, or the permission mode.
A user-approved call presumably carries a different `source`, but that was not observed because this
container auto-approves.
- **Parallel calls.** Several `tool_use` lines are written back to back (about 150 ms apart), and their
  results come back **out of order** (a fast failing `ls` returned before a parallel `sleep 6`). Pair by
  `tool_use_id`, never by position.
- **While a tool runs, nothing is written.** A 6 s `sleep` produced no line between `tool_use` and
  `tool_result`. "Running a tool" and "blocked on a permission prompt" therefore look the same on disk
  until the result arrives (see §4.3).
- Older CC versions wrote `progress` records (`data.type` `bash_progress`/`mcp_progress`, or nested
  subagent messages with `parentToolUseID`). Pixel Agents still handles these [PA]. None were seen on
  2.1.293, so treat them as optional.

**Turn boundaries (main thread).**
- Turn start: `queue-operation` `enqueue` → `dequeue`, then a `user` line with string `content`,
  `origin.kind: "human"`, `promptId`, `turnOrigin`, `turnPosition: {promptIndex, turnIndex}`, and
  `permissionMode`.
- Turn end: an assistant message with `stop_reason: "end_turn"`, then a `system` line
  `subtype: "stop_hook_summary"` (`hookCount`, `hookInfos[].{command, durationMs}`, `hookErrors[]`,
  `preventedContinuation`, `stopReason`, `level`). The stop-hook line came 1.5–2.6 s after `end_turn`.
  **The `stop_hook_summary` line is the best "turn over" marker in the file** (it is absent when the
  user has no Stop hooks, so also accept `end_turn` + quiet period). The bundle also defines a
  `system/turn_duration` record (`duration_ms`, `budget_*`, `message_count`) [bundle]. Pixel Agents
  uses it as turn end [PA]. It was not written in this container.
- **Messages typed mid-turn:** `queue-operation enqueue` while busy, then `remove` with
  `reason: "absorbed_mid_turn"`, plus a `queued_command` attachment (`commandMode: "prompt"`,
  `origin.kind: "human"`). Background-task completions arrive the same way with
  `commandMode: "task-notification"`, `origin: {kind: "task-notification", producer: "session-task"}`.
- Lines without timestamps: `last-prompt` (`lastPrompt`, `leafUuid`) and `atis-latch`. They are
  rewritten after most tool results, so a tailer must not treat them as activity.

**Subagents mid-run.**
- Parent writes the `Agent` `tool_use` (`input.subagent_type`, `run_in_background`, `description`).
  With several parallel `Agent` calls, all `tool_use` blocks stream first. The files appear only when
  the batch executes (observed 14 s after the first `tool_use`).
- The subagent `.jsonl` is created with its first `user` line (`parentUuid: null`, `agentId`,
  `isSidechain: true`, `promptId`). `.meta.json` follows **~80–700 ms later**. Join on
  `meta.toolUseId` = parent `tool_use.id`. Until the meta arrives, bind provisionally by time order.
- Fan-out is visible as N files created within ~20 ms (observed: 2 at once, then 5 at once).
- Async launch: the parent gets a `tool_result` immediately, with `toolUseResult.status: "async_launched"`,
  `isAsync: true`, `agentId`, `outputFile`. **The parent's turn can end (`end_turn`, registry `idle`)
  while its background subagents keep working.** Completion reaches the parent later as a
  `<task-notification>` `queued_command`. Sync subagents end when the parent's `tool_result` for the
  `Agent` call lands.

**Interrupts, errors, compaction** (not producible here; shapes from bundle + parser):
- Interrupt: a `user` text block `[Request interrupted by user]` or `[Request interrupted by user for
  tool use]` [bundle; existing `isInterruptText`]. Bash results carry `toolUseResult.interrupted` (always
  `false` in 17 observed results).
- Tool error: `tool_result.is_error: true` and string `toolUseResult` [observed].
- API error: assistant line with `isApiErrorMessage` / `error` [parser, unobserved]. Live retries are
  only visible in stream-json (`system/api_retry`) or OTel (`api_error`).
- Compaction: `system/compact_boundary` with `compactMetadata.{trigger: manual|auto, preTokens, …}`
  [bundle enum `trigger: ["manual","auto"]`]. The summary user line is marked `isCompactSummary`.

**Context fill.** `total_tokens_reminder` attachments follow nearly every tool result. Together with
the deduped `usage` per `message.id`, that gives live context-fill per call.

**Privacy.** The transcript is the user's full content. The live tailer must apply the same redaction
as ingestion before anything reaches the browser. The WebSocket carries only redacted previews and
shapes (CLAUDE.md privacy rules).

### 2b. Session registry: `~/.claude/sessions/<pid>.json` [observed + bundle]

This is the most useful find in this note. One small JSON per running CC process: `pid`, `sessionId`,
`cwd`, `startedAt`, `procStart`, `version`, `kind` (enum `interactive|bg|daemon|daemon-worker`
[bundle]), `entrypoint`, `name`, `nameSource`, `status`, `statusUpdatedAt`, `updatedAt`,
`peerProtocol`, `peerFeatures[]`, `messagingSocketPath`, and (when waiting) `waitingFor`.
- `status` enum **`busy | shell | idle | waiting`** [bundle]. The CLI derives it as follows: `waiting`
  when a dialog, elicitation, sandbox request, or worker request is open (`waitingFor` e.g.
  `"input needed"`, `"sandbox request"`, `"dialog open"`, plus dialog-specific strings such as
  `"tool permission"`/`"approve plan"`/`"question"` [bundle, mapping not verified live]). Otherwise
  `busy` while loading, else `idle`.
- Observed: `busy` during the main turn. It flipped to `idle` when the main turn ended **while
  background subagents were still running**. So the registry is per process and main-thread scoped.
  It never shows subagent state.
- A sibling `*.key` file sits next to it. **Never read it** (credential material). Read only `*.json`,
  and only the keys above.
- Liveness: `kill(pid, 0)` plus a `procStart` comparison guards against pid reuse. A missing file or a dead pid means the session closed or crashed.
- Unverified: whether every entrypoint (`cli` in a terminal, VS Code, SDK) writes this file, and its
  history across versions. Needs a `docs/sources.md` entry and a fixture before we rely on it. Treat it as optional.

### 2c. Hooks (opt-in; modifies settings)

Event list for v2.1.293 [bundle, full enum]: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`,
`SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
`PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`,
`TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`,
`WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`,
`MessageDisplay`. The [docs] hooks reference (https://code.claude.com/docs/en/hooks) is the
contract. Community guides count about 30 events [COM], consistent with this list.

Common input [bundle zod]: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id?`
(described as "UUID correlating a user prompt with all subsequent events until the next prompt. Same
value emitted on OpenTelemetry events as `prompt.id`"), `permission_mode?`, `agent_id?` (only inside a
subagent; "use this, not agent_type, to distinguish subagent calls"), `agent_type?`, `effort?.level`,
`scratchpad_dir?`. MCP tools add `mcp_server`.

Event-specific inputs [bundle]:

| Event | Fields | Live use |
|---|---|---|
| SessionStart | `source` ∈ startup/resume/clear/compact/fork, `agent_type`, `model`, `session_title` | plant appears |
| UserPromptSubmit | `prompt`, `session_title` | turn_start (**contains prompt text → redact**) |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` | tool_start |
| PermissionRequest | `tool_name`, `tool_input`, `permission_suggestions` | **waiting_permission (exact)** |
| PermissionDenied | `tool_name`, `tool_input`, `tool_use_id`, `reason` | denied (guardrail fired) |
| PostToolUse | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | tool_end (+ exact duration) |
| PostToolUseFailure | … `error`, `is_interrupt`, `duration_ms` | tool_end(error / interrupt) |
| PostToolBatch | `tool_calls[]` | parallel batch done |
| Notification | `message`, `title`, `notification_type` ∈ permission_prompt, idle_prompt, auth_success, elicitation_dialog, agent_needs_input, agent_completed, elicitation_url_dialog, worker_permission_prompt, push_notification, … | waiting states |
| Stop / StopFailure | `stop_hook_active`, `last_assistant_message` / `error`, `error_details` | turn_end / errored |
| SubagentStart / SubagentStop | `agent_id`, `agent_type` / + `agent_transcript_path`, `last_assistant_message`, `stop_hook_active` | delegation |
| PreCompact / PostCompact | `trigger`, `custom_instructions` / `compact_summary` | compaction |
| SessionEnd | `reason` ∈ clear/resume/logout/prompt_input_exit/other | plant leaves |
| TeammateIdle, TaskCreated, TaskCompleted | `teammate_name`, `team_name`, `task_id`, `task_subject`, `task_description` | agent teams |
| CwdChanged, WorktreeCreate/Remove, FileChanged, InstructionsLoaded | `old_cwd/new_cwd`, `name`, `file_path/event`, `file_path/memory_type/load_reason` | worktrees, CLAUDE.md loads |

- `idle_prompt` fires after `messageIdleNotifThresholdMs`, **default 60000** [bundle]. It is
  non-blocking, so it means "turn ended and nobody replied for 60 s", not "blocked". There are
  reports that `Notification:permission_prompt` did not fire in v2.1.226 while `PermissionRequest`
  did [COM: anthropics/claude-code#85171]. **Prefer `PermissionRequest`.**
- Handler types [bundle]: `command`, `http`, `prompt`, `agent`, `mcp_tool`. Options `async: true` ("runs
  in background without blocking"), `asyncRewake`, `once`, `timeout`, `statusMessage`. Garden's hook
  should be `async: true` with a short timeout (or an `http` hook to 127.0.0.1), so it never slows the
  user's agent.
- **Hook payloads carry raw prompt and tool I/O.** The receiving endpoint must redact on arrival, the
  same as ingestion, and should drop fields it does not need (`tool_input` beyond file paths and command
  heads, `tool_response`, `last_assistant_message`, `prompt`).
- Opt-in only: installing writes `~/.claude/settings.json`. Require explicit consent, back up the file,
  merge without clobbering existing hooks, tag our entries for clean uninstall, and show
  install state honestly.

### 2d. OpenTelemetry (opt-in; env only)

Enable with `CLAUDE_CODE_ENABLE_TELEMETRY=1`, plus `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` /
`OTEL_TRACES_EXPORTER` (traces gated by `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`) and
`OTEL_EXPORTER_OTLP_{ENDPOINT,PROTOCOL,HEADERS}`. Intervals come from `OTEL_METRIC_EXPORT_INTERVAL` and
`OTEL_LOGS_EXPORT_INTERVAL` [bundle; docs https://code.claude.com/docs/en/monitoring-usage].
- Metrics [bundle]: `claude_code.session.count`, `token.usage`, `cost.usage`, `lines_of_code.count`,
  `commit.count`, `pull_request.count`, `active_time.total`, `code_edit_tool.decision`.
- Log events (`claude_code.<name>`, with `event.sequence` and `prompt.id`) [bundle]: `user_prompt`,
  `api_request`, `api_error`, `api_retries_exhausted`, `api_refusal`, `assistant_response`, `tool_result`
  (`tool_name`, `success`, `duration_ms`, `decision_source`, `decision_type`, sizes), `tool_decision`,
  `tool`, `hook_execution_start/complete`, `compaction`, `skill_activated`, `subagent_completed`,
  `permission_mode_changed`, `mcp_server_connection`, `at_mention`, `plugin_loaded`, `internal_error`.
- Span names [bundle]: `claude_code.interaction`, `llm_request`, `tool`, `tool.execution`,
  **`tool.blocked_on_user`** (exact permission-wait duration, after the fact), `hook`, `subagent.spawn`,
  `mcp.rpc`, `bash.subprocess`, `compaction`.
- Content gates: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_RAW_API_BODIES`. **Garden should instruct users to leave all
  of these off.** Metadata is enough.
- Use: Garden would run an OTLP/HTTP receiver on 127.0.0.1 (so nothing leaves the machine). The
  endpoint env var must be set in the user's shell or settings `env`, which is a user action.
  Latency is seconds for logs and up to the metric interval for metrics. That suits a cost ticker and
  retries, not animation. Join to transcripts through `prompt.id` = transcript `promptId`.

### 2e. Statusline JSON (opt-in; settings)

The `statusLine` command gets JSON on stdin at each refresh [bundle-embedded doc; docs
https://code.claude.com/docs/en/statusline]: `session_id`, `session_name`, `prompt_id`,
`transcript_path`, `cwd`, `model.{id,display_name}`, `workspace.{current_dir, project_dir,
added_dirs, git_worktree, repo}`, `version`, `output_style`, **`context_window.{total_input_tokens,
context_window_size, used_percentage, remaining_percentage, current_usage}`**, `effort.level`,
`thinking.enabled`, `rate_limits.{five_hour, seven_day, spend_limit}`, **`prompt_cache.{warm,
expires_at, hit_ratio, misses, last_miss_cause}`**, `vim`, `agent.{name,type}`, `pr`, `worktree`,
`cost.total_cost_usd`. A user can configure only one statusline, so Garden would have to wrap the
user's existing one (tee the JSON to a local socket, then exec theirs). That is invasive, so it is
low priority. Context % is derivable from the transcript anyway.

### 2f. `--output-format stream-json` and Agent SDK

Only for processes Garden (or the user's own harness) launches: `claude -p --output-format stream-json
--verbose [--include-partial-messages] [--include-hook-events] [--replay-user-messages]` [ran:
`claude --help`], or the Agent SDK message iterator
(https://platform.claude.com/docs/en/agent-sdk/overview). This stream has explicit lifecycle messages
that the transcript lacks [bundle zod]:
`system/init`, **`system/session_state_changed` (`state: idle|running|requires_action`; described as
the "authoritative turn-over signal")**, `system/task_started|task_progress|task_notification|
task_updated` (`task_id`, `tool_use_id`, `subagent_type`, `is_backgrounded`, `usage.{total_tokens,
tool_uses, duration_ms}`, `last_tool_name`, `status: completed|failed|stopped`),
`system/background_tasks_changed`, `system/hook_started|hook_progress|hook_response` (`outcome`,
`exit_code`), `system/api_retry`, `system/permission_denied`, `system/compact_boundary`,
`system/scheduled_task_fire`, `stream_event` (token deltas), `tool_progress`, `rate_limit_event`,
`result` (`duration_ms`, `duration_api_ms`, `ttft_ms`, cost, usage). The SDK's `canUseTool` callback is
the exact permission-wait signal. Use: the **eval / hill-climbing runner** inside Garden should
launch through this path, which makes the stream the ground truth for those runs.

### 2g. Background tasks, Monitor, /loop, cron, teams, workflows

Tool names present in v2.1.293 [bundle]: `Agent`, `TaskCreate/TaskUpdate/TaskList/TaskOutput/TaskStop`,
`Monitor`, `ScheduleWakeup`, `CronCreate/CronDelete/CronList`, `RemoteTrigger`, `PushNotification`,
`TeamCreate/TeamDelete`, `SendMessage`, `Workflow`, `EnterWorktree`, `Skill`.
- **Background tasks / Monitor:** visible as `tool_use` with `run_in_background: true` (Bash, Agent) or
  `name: "Monitor"`, with completion as a `queued_command` `task-notification` [observed]. Hooks:
  `TaskCreated/TaskCompleted`.
- **/loop and cron:** the `loop` skill uses `ScheduleWakeup` (self-paced) or `CronCreate`. Durable
  schedules live in **`<project>/.claude/scheduled_tasks.json`** [bundle]. A fire is a new turn whose
  origin is not `human`. Stream-json shows `system/scheduled_task_fire`. Detect: `tool_use.name ∈
  {CronCreate, ScheduleWakeup}` ⇒ loop registered; next turn with `origin.kind ≠ human` within the
  expected interval ⇒ loop tick. Exact origin kind values for cron fires are unverified.
- **Agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): team config at
  `~/.claude/teams/<team>/config.json`, tasks under `~/.claude/tasks/<team>/` [bundle]. Teammates are
  separate sessions (each with its own transcript and registry entry). Attachments `team_context`,
  `teammate_terminated`, `teammate_shutdown_batch`, and hooks `TeammateIdle`/`TaskCompleted`.
- **Workflows:** `Workflow` tool_use in the parent. Its steps run as subagents (files under
  `subagents/`, `spawnDepth`). Mark them as a playbook-like run group.
- **Worktrees:** meta `worktreePath`/`worktreeBranch`, subagent `cwd` under `.claude/worktrees/`,
  `EnterWorktree` tool, `WorktreeCreate` hook.

## 3. AI-engineering methods → observable signals

| Method | Live signal (zero-config unless noted) | Detection rule |
|---|---|---|
| Verification loop: hooks | `system/stop_hook_summary` (`hookCount`, `durationMs`, `preventedContinuation`); attachments `hook_blocking_error`, `hook_success`, `hook_additional_context`, `hook_stopped_continuation`, `async_hook_response` [bundle] | `preventedContinuation: true` or a blocking-error attachment followed by more assistant work ⇒ **gate rejected, agent retried** (verification tier tick) |
| Verification loop: tests | Bash `tool_use` whose command head matches a test runner (`pnpm test`, `pytest`, `vitest`, `go test`, …) and its `is_error`/exit code | test run → fail → edit → test run cycle = red/green loop count |
| LLM judge / reviewer | `Agent` with `subagent_type` matching review/judge/verifier, or `prompt`/`agent` hook types | judge subagent after edits; verdict = its result's error flag or a PASS/FAIL marker (heuristic) |
| Ralph-style loop | Same prompt re-submitted repeatedly: consecutive turns with near-identical prompt hash, `origin.kind` non-human, or a Stop hook returning continuation (`preventedContinuation`) | ≥3 turns with the same prompt hash in a session ⇒ ralph loop; tick = each turn |
| /loop, scheduled routines | `CronCreate` / `ScheduleWakeup` tool_use; `.claude/scheduled_tasks.json`; non-human-origin turns at intervals | loop node with period; tick on each fire; "missed tick" if overdue by 2× period |
| Multi-agent fan-out | ≥2 `Agent` tool_use in one `message.id`; N subagent files created within ~1 s | fan-out width = N; join = all their results / task-notifications delivered |
| Worktree isolation | meta `worktreePath`, `cwd` under `.claude/worktrees/` | branch glyph on that subagent |
| Background agents | `run_in_background: true`, `status: "async_launched"`, later `task-notification` | parent idle + child active = "delegated, not blocking" |
| Agent teams | `TeamCreate`, `SendMessage`, team files, per-teammate sessions | team bed; messages as edges |
| Evals / hill-climbing | Many sessions with `entrypoint` `sdk-*`/`cli -p`, same prompt set, differing harness fingerprint; Garden-launched runs via stream-json | experiment groups; score per harness version (correlation caveat applies) |
| Context engineering: compaction | `system/compact_boundary` (`trigger`, `preTokens`); `PreCompact` hook | pruning event; auto vs. manual |
| Context engineering: fill | deduped `usage` per message + `total_tokens_reminder`; statusline `used_percentage` | gauge = input+cache tokens ÷ model window |
| Prompt-cache health | `cache_read`/`cache_creation` per call; statusline `prompt_cache` | hit ratio; cold-cache rebuild spikes |
| Skills on demand | `Skill` tool_use (`input.skill`); attachments `invoked_skills`, `skill_listing` | skill lights up while active; OTel `skill_activated` |
| MCP connectors | tool names `mcp__<server>__<tool>`; `mcp_instructions_delta`; hook `mcp_server` field | connector pipe active during call |
| Permission modes | `permissionMode` on prompt lines (`auto`, `default`, `plan`, `acceptEdits`, `bypassPermissions`); `permissionDecision.reasonType` per result | badge on plant; ratio rule/classifier/mode/user approvals |
| Plan mode | `EnterPlanMode`/`ExitPlanMode` tool_use; attachments `plan_mode`, `plan_mode_exit` | planning state |
| Effort | `effort`/`perTurnEffort` on assistant lines | effort badge |

## 4. Normalized live event model

### 4.1 Types

```ts
/** One agent thread: the main thread of a session, or one subagent invocation. */
export interface AgentRef {
  sessionId: string;
  /** Absent for the main thread. */
  agentId?: string;
  /** 'main' | subagent_type | teammate name */
  agentName: string;
  parentAgentId?: string;
  spawnDepth: number;
}

export type LiveSource = 'transcript' | 'registry' | 'hook' | 'otel' | 'stream' | 'timer';

interface LiveEventBase {
  /** ms epoch from the record timestamp, else receive time */
  t: number;
  /** when Garden saw it; t vs. receivedAt = lag */
  receivedAt: number;
  source: LiveSource;
  agent: AgentRef;
  /** joins hook/OTel/transcript at prompt grain */
  promptId?: string;
  /** true when derived by a timer heuristic, not stated by the source */
  inferred?: boolean;
  /** 0..1, set when inferred */
  confidence?: number;
}

export type ToolCategory = 'read' | 'edit' | 'run' | 'search' | 'web' | 'delegate' | 'mcp' | 'skill' | 'plan' | 'ask' | 'other';

export type LiveEvent = LiveEventBase &
  (
    | { kind: 'session_start'; cwd: string; entrypoint?: string; version?: string; source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'; processKind?: 'interactive' | 'bg' | 'daemon' | 'daemon-worker' }
    | { kind: 'session_end'; reason?: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | 'process_gone' }
    | { kind: 'turn_start'; trigger: 'human' | 'task_notification' | 'scheduled' | 'automated'; permissionMode?: string; promptPreview?: RedactedText; promptHash: string }
    | { kind: 'message_queued'; absorbedMidTurn: boolean }
    | { kind: 'model_output'; blocks: Array<'thinking' | 'text' | 'tool_use'>; messageId: string; model?: string; contextTokens?: number }
    | { kind: 'tool_start'; toolUseId: string; tool: string; category: ToolCategory; mcpServer?: string; skill?: string; filePath?: RedactedText; commandHead?: RedactedText; background: boolean; batchId?: string }
    | { kind: 'tool_end'; toolUseId: string; ok: boolean; interrupted: boolean; durationMs?: number; permission?: { decision: string; source: string; reasonType?: string } }
    | { kind: 'waiting_permission'; toolUseId?: string; tool?: string }
    | { kind: 'permission_resolved'; toolUseId?: string; decision: 'allow' | 'deny' }
    | { kind: 'waiting_input'; reason: 'question' | 'elicitation' | 'plan_approval' | 'idle_after_turn' | 'dialog' }
    | { kind: 'subagent_start'; childAgentId: string; subagentType: string; toolUseId: string; background: boolean; worktree?: boolean }
    | { kind: 'subagent_end'; childAgentId: string; status: 'completed' | 'failed' | 'stopped' | 'unknown' }
    | { kind: 'turn_end'; stopReason?: string; hooksRan?: number; hookPreventedContinuation?: boolean }
    | { kind: 'hook_fired'; event: string; count?: number; durationMs?: number; outcome?: 'success' | 'blocking_error' | 'non_blocking_error' | 'cancelled'; preventedContinuation?: boolean }
    | { kind: 'compaction'; phase: 'start' | 'end'; trigger: 'manual' | 'auto'; preTokens?: number }
    | { kind: 'error'; scope: 'tool' | 'api' | 'stop_failure' | 'hook'; retrying?: boolean; message?: RedactedText }
    | { kind: 'interrupt' }
    | { kind: 'loop_registered'; mechanism: 'cron' | 'wakeup' | 'stop_hook' | 'ralph'; periodMs?: number }
    | { kind: 'loop_tick'; mechanism: 'cron' | 'wakeup' | 'stop_hook' | 'ralph' | 'verification'; iteration: number }
    | { kind: 'context_fill'; usedTokens: number; windowTokens?: number }
    | { kind: 'registry_status'; status: 'busy' | 'shell' | 'idle' | 'waiting'; waitingFor?: string }
  );
```

`RedactedText` is the core branded type. Live events go through `packages/ingest/src/redact`
exactly like stored data. Only `promptHash` (a salted local hash) is used for ralph detection.

Source mapping (transcript ⇒ event): queue `enqueue` ⇒ `message_queued`; `user` string content ⇒
`turn_start`; assistant line ⇒ `model_output` (+ `tool_start` per `tool_use`; `Agent` ⇒ also pending
`subagent_start`); `tool_result` ⇒ `tool_end`; new `subagents/agent-*.jsonl` ⇒ `subagent_start`
(confirmed by meta); `end_turn` / `stop_hook_summary` ⇒ `turn_end` + `hook_fired`;
`compact_boundary` ⇒ `compaction`; interrupt text ⇒ `interrupt`; `isApiErrorMessage` ⇒ `error(api)`.
Hooks map one-to-one (`PermissionRequest` ⇒ `waiting_permission`, `Notification idle_prompt` ⇒
`waiting_input(idle_after_turn)`, and so on). Dedupe across sources by `(agent, toolUseId, kind)`.
A hook event and the transcript line for the same tool call must merge into one event, not two.

### 4.2 Per-agent state machine

States: `idle`, `thinking`, `reading`, `editing`, `running`, `searching`, `delegating`,
`waiting_permission`, `waiting_input`, `compacting`, `done`, `errored`, `gone`.

| From | Event | To |
|---|---|---|
| any live | `turn_start` | `thinking` |
| thinking | `tool_start(c)` | `reading` (Read/Grep/Glob), `editing` (Edit/Write/NotebookEdit), `running` (Bash/Monitor), `searching` (WebSearch/WebFetch/ToolSearch), `delegating` (Agent/Task/Workflow), `waiting_input` (AskUserQuestion, ExitPlanMode) |
| tool state | `tool_end` with no open tools left | `thinking` (model time begins) |
| tool state | `tool_end` with open tools left | state of the most recent open tool (parallel calls) |
| any tool state | `waiting_permission` (hook/registry/timer) | `waiting_permission` |
| waiting_permission | `tool_end` / `permission_resolved` / new transcript line | prior tool state or `thinking` |
| thinking | `turn_end` | `done` (main thread: becomes `idle` after 5 s; subagent: `done` is terminal) |
| any | `compaction(start)` | `compacting`; `compaction(end)` ⇒ `thinking` |
| any | `interrupt` | `idle` |
| any | `error(api, retrying=false)` / `StopFailure` | `errored` |
| any | registry file gone / pid dead | `gone` |

Overlay flags (not states): `hasBackgroundChildren` (parent `idle` while children work, drawn as
"delegated, not blocking"), `toolErrorStreak` (consecutive `is_error`), `permissionMode`, `inLoop`.
`errored` for tool failures is a flag, not a state, since agents routinely recover from them.

### 4.3 Heuristics for states the transcript does not state

All heuristic events carry `inferred: true` and a `confidence`. The UI shows "inferred" in the
"how computed" popover (CLAUDE.md honest-metrics rule).

1. **waiting_permission.** Priority order:
   (a) hook `PermissionRequest` ⇒ certain.
   (b) registry `status: "waiting"` while that session has an open `tool_use` ⇒ high (0.9). The same
   `waiting` status also covers other dialogs, so use `waitingFor` when present.
   (c) Timer: an open `tool_use` for a tool **not** in the exempt set (`Agent`, `Task`,
   `AskUserQuestion`, MCP elicitation tools, any `run_in_background: true` call) and no new line in
   that file for **N = 7 s** (Pixel Agents uses 7 s [PA]). Confidence 0.5 at 7 s, rising with time
   for fast tools (`Read`, `Glob`, `Grep`, `Edit`, `Write` normally finish in < 1 s, so 7 s of silence
   is suspicious) and staying low (0.2) for `Bash`/`WebFetch`/MCP tools, where long runtimes are normal.
   Down-weight to ~0 when the session's recent `permissionDecision` values are all
   `reasonType: rule|mode|classifier` with `permissionMode` `auto`/`bypassPermissions`. In that case
   the user is never prompted (true in this container: 50+ calls, zero user prompts).
   False positives: long builds/tests, `sleep`, network fetches, slow MCP servers, a Bash call
   streaming to a background shell. False negatives: none with (a).
   **Reconcile after the fact:** when the result arrives, a `permissionDecision.source` other than
   `config` confirms that a prompt happened (unverified value). Record the confirmed rate, then tune N.
2. **thinking vs. stalled.** After `tool_result` or `turn_start`, with no assistant line yet, the agent is
   `thinking`. Model gaps of 3–27 s were observed, and long thinking can exceed a minute. After 120 s with
   no line and registry `busy`, show "slow" (no state change). If the registry says `idle`, the turn
   ended without a final line (crash or interrupt) ⇒ `idle`.
3. **Turn end, main thread.** `end_turn` assistant line ⇒ provisional `done`; `stop_hook_summary` or
   `turn_duration` or registry `idle` ⇒ confirmed. Without Stop hooks there is no summary line, so
   confirm after 3 s of silence. False positive: an `end_turn` followed by a Stop hook that
   `preventedContinuation`. Then the turn continues, which is itself a loop tick.
4. **Subagent end.** `stop_reason` is null in subagent files, so use (a) the parent's `tool_result` for
   the `Agent` tool_use (sync), (b) the parent's `task-notification` `queued_command` (async), (c) hook
   `SubagentStop`, (d) fallback: the last line is assistant `text` with no `tool_use` and the file has
   been quiet for 10 s ⇒ `done` with confidence 0.6.
5. **waiting_input.** `AskUserQuestion`/`ExitPlanMode` open ⇒ certain (the tool is the question).
   Main thread ended its turn with text only ⇒ `idle` (not "waiting"). Pixel Agents marks this as
   waiting after 5 s [PA]. We treat it as idle, and use `Notification idle_prompt` (60 s default) only to
   add a "nobody has replied" badge.
6. **Interrupted.** Interrupt text, or an open `tool_use` whose result is an `is_error` with interrupt
   text, or registry `idle` with open tools ⇒ `idle` + interrupt mark.
7. **Session liveness.** The file has not changed for 10 min and there is no registry entry ⇒ not live
   (Pixel Agents uses 10 min mtime + ≥3 KB for external-session discovery and drops stale agents
   after 30 s of a dead process [PA]). With the registry, use the pid check instead of mtime.
8. **Loop tick (verification tier).** A `stop_hook_summary` with `preventedContinuation` or a
   `hook_blocking_error` attachment, followed by more assistant work in the same turn ⇒
   `loop_tick(verification)`. A test-command Bash `tool_end(ok=false)` followed by an edit and the same
   test command ⇒ red/green iteration.

### 4.4 Tailer implementation notes

- Watch `~/.claude/projects/**` and `~/.claude/sessions/*.json` with `fs.watch` plus a 500 ms–1 s
  `stat` poll fallback (fs.watch is unreliable on network filesystems and on macOS for appends).
  Track a per-file byte offset. Buffer to the last `\n`. Tolerate truncation (offset > size ⇒ re-read)
  and `/resume` (new file, same `sessionId`).
- On startup, seed state from the last ~256 KB of each recently modified file (Pixel Agents uses 256 KB
  [PA]). Do not replay whole files.
- Ignore `last-prompt`/`atis-latch` lines as activity. Count unknown types into the `garden inspect`
  census (tolerant-parser rule).
- Server pushes redacted `LiveEvent`s over WebSocket/SSE on 127.0.0.1. The renderer keeps per-frame
  state out of React (CLAUDE.md).

## 5. How Pixel Agents does it [PA, v1.4.1 bundle]

- Two modes: **hooks mode** (default in their product) and **heuristic mode** (JSONL scanning under
  `~/.claude/projects/`). Transcripts are read in both modes for details missing from hook events.
- Installs hooks for: `SessionStart`, `SessionEnd`, `Stop`, `PermissionRequest`, `Notification`,
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle`,
  `TaskCompleted` into `~/.claude/settings.json`, keeping a `.pixel-agents.backup`. The hook script reads
  stdin, discovers live servers in `~/.pixel-agents/servers/*.json` (pid-checked), and POSTs to
  `127.0.0.1:<port>/api/hooks/claude` with a bearer token and a 2 s timeout. It always exits 0.
- Mapping: `PermissionRequest` and `Notification(permission_prompt)` ⇒ permission bubble;
  `Notification(idle_prompt)` ⇒ turn end awaiting input; `Stop` ⇒ turn end; `PreToolUse` ⇒ tool start;
  `PostToolUse(Failure)` ⇒ tool end; `SessionEnd(clear|resume)` ⇒ wait 2 s for a follow-up `SessionStart`.
- Heuristics: permission timer **7 s** on non-exempt open tools (exempt: `Task`, `Agent`,
  `AskUserQuestion`); text-only assistant reply with no tools in the turn ⇒ waiting after **5 s**;
  `system/turn_duration` ⇒ turn end; tool-done animation delay 300 ms; stale external agent removal
  30 s; external session discovery requires mtime < 10 min and size ≥ 3 KB. Context window: 200K for
  haiku/claude-3/4.0–4.1 models, else 1M. Tool → animation: reading tools `Read/Grep/Glob/WebFetch/WebSearch`
  ⇒ "reading", others ⇒ "typing".
- Their consent model: hook install/uninstall only from a token-holding client. The README is explicit
  that installing edits the agent tool's settings file.

What Garden adds beyond Pixel Agents: the registry `waiting` status (no hooks needed for most
permission waits), `permissionDecision` reconciliation to measure heuristic accuracy, subagent
`.meta.json` joins (fan-out trees, worktrees), loop/verification detection, and harness context on
every plant.

## 6. Open items to verify before building

1. Registry file across entrypoints (terminal `cli`, VS Code, SDK) and versions. Live check of
   `waitingFor` values during a real permission prompt (this container auto-approves everything).
2. `permissionDecision` values when a human approves or denies (`source`, `decision`).
3. Real fixtures for `compact_boundary`, interrupts, `turn_duration`, API errors, cron-fired turn
   `origin.kind`, and teammate transcripts. Add each to `docs/sources.md` with its version when seen.
4. Fetch the official hooks / monitoring / statusline pages from a network that allows them, and diff
   against the [bundle] lists here.
5. Whether `fs.watch` on macOS delivers append events promptly for `~/.claude/projects` (poll fallback
   regardless).
