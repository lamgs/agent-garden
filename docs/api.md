# Local API

Served by `garden serve` on **127.0.0.1 only** (default port 4310). Response shapes are the view
contracts in `packages/core/src/views.ts`. Every response carries a strict Content-Security-Policy
(no remote origins, no eval).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok, schemaVersion, runs, asOf, live }` (`live`: whether the live layer runs, so the web app only opens the stream when it exists) |
| GET | `/api/legend` | Legend entries generated from the encodings registry |
| GET | `/api/garden?days=90&asOf=<ISO>` | `GardenView` |
| GET | `/api/plant/:plantId?days=` | `PlantView` (404 if the planting has no runs in the window) |
| GET | `/api/compare?left=<bedId>&right=<bedId>&days=` | `BedCompareView` |
| GET | `/api/replant?agent=<agentId>&from=<bedId>&to=<bedId>&days=` | `ReplantView` |
| GET | `/api/seasons/:bedId?days=&asOf=` | `SeasonsView` (404 for an unknown bed or one with no runs in the window) |
| GET | `/api/replay/:runId` | `ReplayView`: frames with deduped context fill and cumulative tokens/cost, child runs to depth 3 (404 for an unknown run; no window filter) |
| POST | `/api/runs/:runId/label` | `{ runId, outcome }`, body `{ label: success\|partial\|failure\|unknown\|clear, note? }` |
| GET | `/api/route?q=<task>&days=&limit=` | `RouterResult` ("Which one do I call?"). `q` 1..500 chars (trimmed), `limit` 1..20 (default 5) |

`days` is 1..3650 (default 90). `asOf` pins "now". The demo uses the dataset's end date.

The router index (BM25 + TF-IDF/LSA + outcome kNN, `packages/router`) is built from the window's
runs on first use and cached per `days|asOf` (4 windows, LRU). A manual label clears the cache so
the outcome component sees it. The query is never stored or logged.

## Guards (local-only by construction)

- **Bind address**: the listener binds `127.0.0.1`. A test asserts `server.address()`.
- **DNS rebinding**: every request whose `Host` is not `127.0.0.1`, `localhost`, or `[::1]` gets a
  403. This stops a malicious site that resolves its own domain to 127.0.0.1 from reading your garden.
- **CSRF**: non-GET requests need an `Origin` on a loopback host **and** `Content-Type:
  application/json`. Cross-site form posts and no-cors fetches cannot meet both.
- **Label notes** pass through the ingestion `Redactor` before they reach the store, the same as
  transcript text. Manual labels live in their own table and survive re-ingestion.

`garden label <runId> <label> [--note]` writes the same labels from the command line.

## Live layer

`garden serve` turns the live layer **on by default**: it tails the local Claude Code transcripts
(`~/.claude/projects`, or `<--claude-home>/projects`, or `--live-projects <dir>`). That reads files
this user can already read and writes nothing (the live layer keeps everything in memory). Flags:
`--no-live` (off), `--live-demo [--live-seed N --live-speed X]` (replay the store's runs instead;
`pnpm demo` uses this), `--live-minutes N` (only files modified in the last N minutes are tracked
at start, default 30). `garden live:probe --seconds N` prints event shapes and latency, never content.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/live` | `LiveSnapshot` (404 `{error}` when the live layer is off) |
| GET | `/api/live/stream` | `text/event-stream` of `LiveMessage`s (404 when off) |

Both sit behind the same loopback-host guard as the rest of the API.

**SSE message sequence.** Each frame is `event: <type>` + `data: <JSON LiveMessage>` (the JSON
includes `type`, so a plain `onmessage` parser works too; `event` frames also carry `id: <seq>`):

1. exactly one `snapshot` (`{type:'snapshot', snapshot}`), taken in the same tick as the subscription,
   so no message falls between them;
2. then, per observed record: one `event` (`{type:'event', event}`, `seq` monotonic per server
   process) followed by one `agent` (`{type:'agent', agent}`) per agent whose state changed (a
   parent's `subagent_end` also updates the child);
3. from the 1 s heuristic tick: `agent` messages (waiting_permission / idle) and
   `gone` (`{type:'gone', agentKey}`) when an agent had no event within `activeWindowSec` (default
   1800; parents stay while a child is active) or its process exited (session registry);
4. a comment line `: heartbeat` every 15 s.

A reconnect gets a fresh snapshot (`Last-Event-ID` is ignored). A disconnect unsubscribes the client
and clears its heartbeat timer.

**Privacy.** Every `preview` / `detail` passed the ingestion `Redactor` (on up to 20,000 chars) and was
then cut to ≤ 120 chars without splitting a redaction marker. Thinking text is never emitted (thinking
events carry no preview). Tool-result text is only previewed for errors. Sensitive paths (`.env`,
keys, …) show `[sensitive path]`. A test plants every secret kind in a tailed transcript and checks
the SSE bytes.

**How `activity` is decided** (`evidence` says which rule fired):

| Signal | Activity |
|---|---|
| human prompt | `thinking` ("prompt received") |
| thinking block / assistant text | `thinking` |
| open `Read`/`LS` | `reading`; `Grep`/`Glob`/`ToolSearch` `searching`; `Edit`/`Write`/`NotebookEdit` `editing`; `Bash` (and unknown built-ins) `running`; `WebFetch`/`WebSearch` `web`; `mcp__*` `mcp`; `Skill` `skill`; `Agent`/`Task` `delegating`; `AskUserQuestion`/`ExitPlanMode` `waiting_input` |
| parallel calls | the newest open call; results pair by `tool_use_id` |
| `stop_reason` end_turn (stop_sequence, max_tokens, refusal) | main `waiting_input`, subagent `done` |
| parent `tool_result` for the spawn, or `<task-notification>` (background) | child `done` (`errored` on is_error / failed status) |
| `compact_boundary` | `compacting` |
| tool_result `is_error`, API error record | `errored` (next record moves on) |
| user interrupt | `waiting_input` |
| open call, no newer line > 6 s (Bash / web / MCP: 30 s) | `waiting_permission`, evidence "possibly …" (a slow tool looks the same); never for delegation, background calls, or sessions whose last ≥ 3 calls were auto-approved (`permissionDecision.source: config`) or `bypassPermissions` |
| session registry `status: waiting` + open call | `waiting_permission` (evidence names `waitingFor`) |
| result after a guess | evidence reconciles the guess with `permissionDecision` |
| no line > 5 min | `idle` |

`contextTokens` = input + cache read + cache write of the latest API message (taken once per
`message.id`). `contextWindow` comes from the pricing table (200,000 when the model is unknown).
`bedId` uses the history adapter's `canonicalProjectRoot` + `familyId`, so worktrees fold into their
repo and live agents join the history views; `plantId` is set when that planting exists in the store.

**Demo source** (`--live-demo`, `source: 'demo'`): a deterministic schedule per seed (cycle k uses
seed + k) replays stored main runs from several beds on 4 concurrent lanes, gaps compressed 8x and
clamped to 0.2–2.5 s, subagent runs play between the parent's spawn and its result, and each cycle
includes a compaction and a tool error (when the dataset has them) and one fast tool call stalled for
8.5 s so the waiting_permission heuristic fires.
