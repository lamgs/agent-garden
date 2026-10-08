# Visual identity research: live agent visualization

Status: research note, 2026-10-08. Nothing here is decided. It answers one question: should Agent
Garden's look become something like Pixel Agents (a live pixel-art office), and if so, how, without
breaking the mapping rule, the privacy rules, or the data contracts we already have.

Read with: `CLAUDE.md` (vocabulary, mapping rule), `PLAN.md` §7–§8 (contracts, encoding spec),
`packages/core/src/encodings.ts` (registry), `packages/core/src/views.ts` (contracts), `docs/design.md`.

**Short answer.** Don't replace the garden with an office. Add a **live layer to the garden**:
pixel-art *gardeners* (one per active run) walk to the plant they are running and work it. Verification,
shipping, and harness-editing get their own stations in each bed. Loop vocabulary comes from factory
games, and the "needs you now" queue comes from air-traffic control. Draw everything procedurally in
code. Pixel Agents' code is MIT, but the provenance of its art is not clear enough to ship. Details
in §5.

---

## 1. Pixel Agents in depth

Repo: [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents), studied at commit
[`3537e14`](https://github.com/pixel-agents-hq/pixel-agents/tree/3537e140c2094761beae748592aeb92ece8edfdd)
(2026-08-15, package version 1.4.1). Below, `PA:` links point at files in that commit. I cloned it
and read the source. Facts below come from the code or from its own `CLAUDE.md` / `CONTEXT.md`.

### 1.1 What it is

- A VS Code extension plus a standalone CLI (`npx pixel-agents`, Fastify server, browser SPA on
  `127.0.0.1` by default). "Every Claude Code terminal gets its own animated character." They walk
  to desks, type while editing, read while searching, and show speech bubbles when blocked
  ([README](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/README.md)).
- Stack: React 19 + Vite webview, **Canvas 2D** (not PixiJS), an imperative `OfficeState` outside
  React, a rAF loop with a 0.1 s delta cap, BFS pathfinding on a tile grid
  ([PA: CLAUDE.md](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/CLAUDE.md)).
- The server-to-UI protocol is an AsyncAPI 3.0 contract (27 server message variants, 18 client
  variants), code-generated into `core/src/messages.ts` with a CI drift check.
- Its stated direction is "play a game, build a product": health bars for rate limits and token
  budgets, scores, orchestrator characters, drag-a-box to form a team. Most of that is not built yet.

### 1.2 How Claude Code activity becomes character state

There are two detection paths. Both normalize to one `AgentEvent` union, and the runtime dispatches on
`kind`, never on tool names. The kinds are `toolStart, toolEnd, turnEnd, subagentStart, subagentEnd,
subagentTurnEnd, progress, permissionRequest, sessionStart, sessionEnd`
([PA: CLAUDE.md "Provider Abstraction"](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/CLAUDE.md)).

**Hooks mode (default).** It installs a hook script into `~/.claude/settings.json`, after consent and
with a one-time backup. The script POSTs to `/api/hooks/:providerId` with a bearer token. Installed
events ([PA: constants.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/server/src/providers/hook/claude/constants.ts)):
`SessionStart, SessionEnd, Stop, PermissionRequest, Notification, PreToolUse, PostToolUse,
PostToolUseFailure, SubagentStart, SubagentStop, TeammateIdle, TaskCompleted`. It deliberately does
**not** install `UserPromptSubmit` or `TaskCreated`, because that would forward prompt text it then
throws away. That is a privacy choice worth copying.

Normalization ([PA: claude.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/server/src/providers/hook/claude/claude.ts)):

| Hook event | `AgentEvent` | Character effect |
|---|---|---|
| `PreToolUse` | `toolStart` (tool name, status text) | Active: walk to seat, then type or read |
| `PostToolUse`, `PostToolUseFailure` | `toolEnd` | Tool row done (delayed 300 ms so brief states stay visible) |
| `Stop` | `turnEnd` | Inactive "done": green check bubble, fades after 2 s, character later wanders |
| `Notification` `permission_prompt` / `PermissionRequest` | `permissionRequest` | Amber "…" bubble that stays until resolved, plus a chime |
| `Notification` `idle_prompt` | `turnEnd {awaitingInput}` | "Waiting for input" |
| `SubagentStart` / `SubagentStop` | `subagentStart` / `subagentEnd` | Sub-character spawns or despawns near the parent |
| `TeammateIdle` / `TaskCompleted` | `subagentTurnEnd` | Teammate idle or done |
| `SessionStart` / `SessionEnd` | `sessionStart` / `sessionEnd` | Spawn or despawn (matrix-rain effect, 0.3 s) |

Tool → animation: `readingTools = {Read, Grep, Glob, WebFetch, WebSearch}` use the *reading* frames,
and everything else uses *typing*. `permissionExemptTools = {Task, Agent, AskUserQuestion}`. The activity label
comes from `formatToolStatus` ("Reading foo.ts", "Running: <cmd…>", "Subtask: <desc>", "Using <tool>").

**Heuristic mode (fallback, transcript tailing).** It polls JSONL every 500 ms with partial-line
buffering, runs a project scan every 1 s, an external-session scan every 3 s, and a stale check every 30 s. Turn end
comes from a `system` record with `subtype: "turn_duration"`. **Permission waits are inferred**: a
non-exempt tool with no new data for `PERMISSION_TIMER_DELAY_MS = 7000` raises the bubble. Text-idle
is 5 s ([PA: server/src/constants.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/server/src/constants.ts)).
They also read `progress` records (`agent_progress`, `bash_progress`, `mcp_progress`). Pixel Agents
says it supports transcript formats up to Claude Code v2.1.220. We observed v2.1.293. We have
**not** observed `turn_duration` or `progress` records ourselves (see `docs/sources.md`), so treat
those as hypotheses for us.

**Context gauge** ([PA: contextUsage.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/server/src/contextUsage.ts)):
a *level, not a total*. It uses the newest main-chain turn's `input + cache_creation + cache_read + output`
tokens over a per-model window (1M for current models, 200k for Haiku and older). All-zero usage means
"no news", so it doesn't blank the gauge. Sidechain records don't move the lead's gauge. It falls on compaction or `/clear`.
UI thresholds are 60 / 80 / 95 %, and the gauge is 40×4 px
([PA: webview-ui/src/constants.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/webview-ui/src/constants.ts)).

### 1.3 Character state machine and sprites

- FSM states: `idle | walk | type` ([PA: types.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/webview-ui/src/office/types.ts),
  [PA: characters.ts](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/webview-ui/src/office/engine/characters.ts)).
  `type` covers both typing and reading frames. Active means pathfind to the seat and type or read.
  Inactive "done" means wander with BFS for 3–6 moves with 2–20 s pauses, then rest in the seat 120–240 s.
  Characters whose agent is waiting for input or permission stay seated.
- Timing: walk 48 px/s, walk frame 0.15 s, type frame 0.3 s. Characters sit 6 px lower while typing.
- **Tile size 16 px.** **Character sprite 16×32**: one PNG per palette is 112×96, which is 7 frames ×
  16 px wide by 3 direction rows × 32 px (down, up, right; left is mirrored). Frame order: walk1–3,
  type1–2, read1–2. Six palettes. Beyond six agents, the palette repeats with a random hue shift of 45–315°.
- Floors: 7 grayscale 16×16 patterns colorized per tile. Walls: a 4×4 atlas of 16×32 auto-tile pieces
  (4-bit N/E/S/W mask), each extending 16 px above its tile.
- Rendering is pixel-perfect: integer zoom 1×–10×, default `round(2 × devicePixelRatio)`, z-sort by y.
- Bubbles and context gauge are drawn per character. Sprite data lives as JSON/TS in `sprites/`.

### 1.4 Layout model

- `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors? }`. The default is
  20×11 tiles and the max is 64×64. It persists to `~/.pixel-agents/layout.json`. There is a full layout editor (floor and wall
  paint, furniture placement and rotation, undo).
- **Seats** come from chair furniture. Seat assignment is persisted and reassigned by click.
  **Areas** are named tile regions mapped to workspace folders, and agents launched from a folder prefer
  seats in its area. That is the closest analog to our bed = harness family.
- Electronics switch to an "on" sprite when an active agent faces a desk within 3 tiles. That is a nice
  "the room responds to work" touch.

### 1.5 Sub-agents and teammates

From [PA: CONTEXT.md](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/CONTEXT.md)
and the TeamProvider section of their `CLAUDE.md`:

- **Sub-agent**: unnamed delegated work. It gets its own small character *near its parent, not in a seat*
  (closest free walkable tile), shares the parent's palette, and isn't persisted. It has no context gauge.
  Background spawns are tracked through a "shadow store" that watches the child transcript.
- **Teammate**: a *named* agent spawned by a Lead (Claude Agent Teams). It has its own seat and transcript,
  takes the free seat nearest its Lead, and the Lead gets a gold marker (`TEAM_LEAD_COLOR`). Detection covers
  four modes (basic subagent, inline teammate, tmux teammate, implicit team on Claude 5 harnesses
  via `~/.claude/teams/session-<8hex>/config.json`).
- "Headless" agents (non-interactive runs) can optionally be drawn as translucent ghosts.

### 1.6 What Pixel Agents does *not* do (from our point of view)

It is a live presence view. It has no history, no outcome or success measure, no cost, no harness
versions, no skills, playbooks, or loops, and no hygiene. Several visual properties carry no
metric: palette choice, random wander, pets, the matrix-rain spawn effect. That's fine for its
goal, but it breaks our mapping rule unless each is labeled "ambient, no meaning".

### 1.7 Licenses: code and art

| Item | License | What it means for us |
|---|---|---|
| Pixel Agents code | MIT, © 2026 Pablo De Lucca ([LICENSE](https://github.com/pixel-agents-hq/pixel-agents/blob/3537e140c2094761beae748592aeb92ece8edfdd/LICENSE)) | We may read and adapt ideas or code with the notice kept. We don't need to: our stack (PixiJS, Hono, our own store) differs, and re-implementing the ~10 rules above is small. |
| Bundled character PNGs (`assets/characters/char_0..5.png`) | No separate art license in the repo. README: "based on the amazing work of JIK-A-4, Metro City" | They are *derived* from a third-party pack. The repo's MIT notice doesn't clearly cover them. **Don't ship them.** |
| JIK-A-4 "MetroCity – Free Top Down Character Pack" ([itch.io](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)) | No formal license text found. The listing and author comments (via search; itch.io is blocked from this container) say free, "use it as you wish", commercial OK, credit appreciated but not required | Permissive in spirit, but informal: no named license, and terms only in comments. I couldn't read the page directly. **Don't depend on it.** |
| Furniture/floors/walls | CHANGELOG #117: "Replaces bundled proprietary tileset with open-source assets"; the per-asset license is not stated | Unknown provenance per asset. Don't ship. |
| Donarg "Office Interior Tileset (16x16)" ([itch.io](https://donarg.itch.io/officetileset)) | Recommended in their docs as a *user-supplied* external pack (paid) | Not redistributable by us. |

**Consequence:** we draw our own sprites procedurally in code, as palette-index grids (§6.3). This
fits our rules anyway: no binary assets of unclear origin, every pixel derived from a palette that
the dataviz validator has checked, and sprite variation generated from metrics (the plant
"genotype" already works this way).

---

## 2. Other references worth stealing from

| Reference | What it is | Idea worth stealing | Caution |
|---|---|---|---|
| [a16z AI Town](https://github.com/a16z-infra/ai-town) ([architecture](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md)) | MIT starter kit; characters live in a tile town, PixiJS renderer, Convex backend as the game engine | A **deterministic game-loop/state split**: the engine advances world state in ticks; the client interpolates. Our server sends state deltas; Pixi interpolates walking. | Art is credited to OpenGameArt contributors and ansimuz under their own terms. Same lesson: don't reuse art. |
| [Generative Agents / Smallville](https://github.com/joonspk-research/generative_agents) | Stanford UIST '23 paper code; Phaser front end; Apache-2.0 per forks | **Replay by URL** (`/replay/<sim>/<step>`): a recorded simulation is re-watchable. Our `ReplayView` already exists; a live view and a replay should be the *same renderer fed by the same event type*. | Their replay is a debug tool, and all sprites in it look alike. Make ours legible. |
| [AI Village (AI Digest)](https://theaidigest.org/village) | Several frontier agents, each with its own computer, streamed live on weekdays with a public [timeline](https://theaidigest.org/village/timeline) | **A changelog of scaffolding changes** next to behavior, so viewers can tell a model or prompt change from emergent behavior. That is exactly our Seasons idea. Show harness-change markers *in the live view too*. | Not open source. Concept only. |
| [claude-office](https://github.com/paulrobello/claude-office) (MIT; Next.js + **PixiJS** + FastAPI) | Boss (main agent) + employees (subagents) in a multi-floor pixel office | **Context as a trash can that fills, with the boss stomping it on compaction**, and a safety sign counting tool uses since the last compaction. Concrete, metric-bearing props. | Art source not stated. |
| [agent-factory](https://github.com/britonbakerfluid/agent-factory) (MIT; Phaser 3, Fastify WS) | Agents at arcade cabinets; selectable backgrounds: arcade, farm, office, mining | Clean **hook → scene mapping** (SessionStart: spawn at entrance; PreToolUse: walk to a cabinet; Stop: back to the lounge; SessionEnd: exit). Tool icons: magnifier = read/search, pencil = edit, terminal = Bash, globe = web, chat = Agent, brain = plan mode. Shared multi-user server. | Theme is skin-deep: the background encodes nothing. |
| [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability), [simple10/agents-observe](https://github.com/simple10/agents-observe) | Hook → server (SQLite) → WebSocket → dashboard; swim lanes per agent, live activity pulse chart | **Swim lanes per agent** and a live events-per-minute pulse. A fork of agents-observe rebinds to 127.0.0.1 because captured prompts were exposed on the LAN. That is a reminder that the hook payload is sensitive. | They store raw hook payloads. We must redact at entry. |
| [ccusage](https://github.com/ryoppippi/ccusage) | CLI usage/cost reports from local JSONL (daily, session, **5-hour billing blocks**) | **Billing-window framing**: "how much of this 5-hour block have I burned" is a metric people act on live. Candidate live channel. | Shows cost only, no outcomes. |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | TUI managing many agents in tmux + git worktrees | **The list is the product**: one row per agent with its status. Our pixel view needs a DOM twin (we already require `T` tables). Worktree isolation matches our worktree folding into beds. | No visualization beyond the list. |
| [Langfuse agent graphs](https://langfuse.com/docs/observability/features/agent-graphs), [timeline view](https://langfuse.com/changelog/2024-06-12-timeline-view) | Trace tree, timeline, and agent graph with **Aggregated** (repeated steps merged into one node with a counter, loops drawn as cycles) vs **Expanded** (loops unrolled) modes | The aggregated/expanded toggle is the right model for our two layers: the **history layer is aggregated** (cycles, counts) and the **live/replay layer is expanded** (each step). | Generic look. |
| [Netflix Vizceral](https://github.com/Netflix/vizceral) | WebGL animated traffic graph: global → region → service drill-down; particle density = request rate, red particles = errors | **Particle density as rate, particle color as error share**. A real encoding for irrigation/belt flow. Semantic zoom in three levels, like ours. | Unmaintained per its README. |
| [kube-ops-view](https://github.com/hjacobs/kube-ops-view) | Read-only cluster dashboard: nodes as boxes, pods as small squares with status color and CPU/mem bars; TV dashboard mode | **Tiny-square-per-unit grids**: one pixel block per run in the window, colored by outcome. A dense and honest history glyph. Typing filters grey out non-matches. | Dated (2020). |
| Factorio ([production statistics](https://wiki.factorio.com/Production_statistics), [modules](https://wiki.factorio.com/Module), [alerts](https://wiki.factorio.com/Alerts)); [shapez](https://shapez.io) | Factory/conveyor builders | **Belts as loops** with visible backlog. **Modules in machine slots** (skills). **Alert icons** for "no input", "output full", "no power" (dry loop, runaway loop, budget). **Power draw** as a running cost meter. Production graphs over 5 s/1 m/10 m/1 h/10 h windows match our loop tiers. | Belt routing is a layout problem. Keep belts schematic. |
| RimWorld ([mood](https://rimworldwiki.com/wiki/Mood), [work tab](https://rimworldwiki.com/wiki/Work)), [Dwarf Fortress](https://dwarffortresswiki.org/index.php/Labor) | Colony sims: needs bars, mood with explicit "thoughts" lists, job queues, work priorities | **Mood with its reasons listed** is the game version of our `OutcomeEvidence`: a single number always shown with the itemized causes. A **job queue** per agent maps to queued commands and background tasks. | Mood is fiction; ours must be measured. |
| [Townscaper](https://www.townscapergame.com) | Procedural town that rearranges itself from simple clicks | **Procedural generation from a few parameters** produces variety without assets, the same approach as our plant genotypes. Calm palette and no UI clutter. | No data. |
| [Flight progress strips](https://en.wikipedia.org/wiki/Flight_progress_strip) (ATC) | Physical strips moved between bays: pending, active, holding, handed off | **Attention triage by position**: where a strip sits is its state, and holding is a bay. A great model for "which agents need me now", sorted by wait time. | Not a garden. Use as a DOM panel, not a world. |
| [Stardew Valley shipping bin](https://stardewvalleywiki.com/Shipping) | Put produce in the bin; it's tallied overnight | **Shipping as a daily tally**: the application-tier loop (commit/PR/deploy) ships work, and the tally shows next to the field. | Game reference only. |

Common pattern across the Claude Code pixel tools (Pixel Agents, claude-office, agent-factory,
Claude Pixel Quest): **one character per session, walk to a station, an animation per tool family, a
bubble per blocking state.** That is the expected "live" vocabulary now. None of them carries
outcome, cost history, harness versions, or loops. That gap is our differentiation.

---

## 3. Ground rules for any option

1. **Two layers, always separable.** The *live layer* animates from events as they stream in: what is
   happening now, a few seconds stale at most. The *history layer* shows aggregates over the selected
   window, using the existing encodings. A toggle (or reduced motion) hides the live layer, and the
   history layer must still make sense.
2. **Every live animation is an encoding** with a registry entry (`element`, `channel`, `metric`,
   `howComputed`, `action`, `levels`). Wandering, idle bobbing, and pets are allowed only as
   `ambient, no meaning`. Walking *between stations* is allowed because the destination encodes state,
   but walk speed and path are ambient.
3. **Say where a live state came from.** Each live state carries `source: 'hook' | 'transcript' | 'inferred'`.
   Inferred states (permission wait after 7 s of silence, turn end without a marker) are drawn with a
   dashed outline. This is the live equivalent of today's dotted "configured, not recorded" irrigation.
4. **Identity is never color alone** (`docs/design.md`). Model family stays on the validated
   bed-edging colors plus a text label. Characters wear the model-family color on a garment and carry
   a nameplate.
5. **Privacy carries over unchanged.** Live labels ("Editing foo.ts") are `RedactedText` previews
   produced at ingestion. Hook payloads are redacted on receipt, before any queue or store. Nothing is
   sent anywhere except over `127.0.0.1`.

### What we can know live (data reality)

| Signal | Transcript tail (no install) | Hooks (opt-in install) | Notes |
|---|---|---|---|
| Run start (human prompt) | yes: `user` line with `origin.kind: human` | `UserPromptSubmit`, but don't install it (prompt text) | Run start from the transcript is enough |
| Tool start / end, tool name, `is_error` | yes: `tool_use` / `tool_result` lines | `PreToolUse` / `PostToolUse(Failure)` | Transcript lines land after each content block is written; latency is about 0.5–1 s with polling |
| Loop tier of a step | yes (our classifier) | yes (same classifier on `tool_name` + redacted input) | Verification and application come from command patterns |
| Subagent spawn / finish, agent type | yes: `Agent` tool_use, `subagents/agent-<id>.jsonl` + `.meta.json`, `<task-notification>` | `SubagentStart` / `SubagentStop` | Both observed or SDK-documented in `docs/sources.md` |
| Context fill | yes: `usage` per `message.id` (dedupe) | no | Subagent output tokens are stream-start only: mark as estimated |
| Compaction | hypothesis: `system` `compact_boundary` (parser already handles it; no real fixture yet) | `PreCompact` | Mark unverified until a fixture exists |
| Stop hook ran / blocked | yes: `system` `stop_hook_summary` (`preventedContinuation`) | `Stop` | Observed |
| Permission wait | **no** direct record; infer from silence after a non-exempt tool (Pixel Agents: 7 s) | **yes**: `PermissionRequest`, `Notification` `permission_prompt` | The main reason to offer hooks at all |
| Waiting for input / turn end | infer: assistant `end_turn` with no pending tool; `turn_duration` (reported by Pixel Agents, not seen by us) | `Stop`, `Notification` `idle_prompt` | |
| Live cost | yes: tokens × `pricing.ts` at query time | no | Never stored as dollars |

Two cautions for hooks: (a) installing our hook edits `~/.claude/settings.json`, which **changes every
bed's harness fingerprint** (`hookCount`) and would create a fake "season". The fingerprint and the
weeds detector must ignore our own hook entry by identity. (b) Hook payloads include `tool_input`
(file contents for Write, commands for Bash). Keep only `hook_event_name, session_id, tool_name,
notification_type, agent_id, agent_type`, plus a redacted preview, and drop the rest at the socket.

---

## 4. Alternative metaphors

Each table uses PLAN §8 style, with columns for the two layers. "Live" = what animates on an event.
"History" = channel = metric (scale). Rows whose history channel says "existing" reuse an
encoding from `encodings.ts` unchanged, with only the drawing swapped.

### 4.A "Pixel Studio": the office (closest to Pixel Agents)

One **room** per harness family. One **desk** per planting. Runs are **characters** who come in, sit, and work.

| Concept | Element | Live layer (event → animation) | History layer (channel = metric, scale) | Action it prompts |
|---|---|---|---|---|
| Harness family (bed) | Room with a door sign | Room lights on while any run in it is active | Wall trim color + label = model family (existing `bed.tone`); pegboard density = tools + MCP count (existing `bed.texture`); binder-shelf thickness = CLAUDE.md bytes (existing `bed.strata`) | Compare harnesses; too many tools; bloated instructions |
| Harness version (season) | Wall calendar with a version tag | A hill-climbing edit flips the calendar ("v7 → v8") and puts a 1-run "new harness" ribbon on desks that run next | Seasons view: tinted bands per version (existing `season.band`) | Line up harness changes with outcomes (correlation) |
| Agent (planting) | Desk + nameplate | Desk monitor turns on when a run of this agent starts | Desk tier (stool → workstation) = runs in window (log, 5 bins; `plant.height`) | Load-bearing vs unused |
| Run (main thread) | Character, shirt = model-family color | Spawns at the door on a human prompt, walks to its desk, **types** (Edit/Write/Bash/NotebookEdit), **reads** (Read/Grep/Glob/Web*), phone pose for `mcp__*`; one keystroke spark per tool call; leaves at run end | — (counted in desk tier) | See what is running now |
| Subagent | Small character, same shirt as parent + type badge | Spawns beside the parent, walks to the child agent's desk (custom types) or a hot-desk pool (built-ins), works there, walks back with a folder on finish | Worn carpet path between desks = calls parent → child (3 bins; `bee.count`) | See handoffs |
| Teammate (Agent Teams) | Full character with own seat; lead wears a badge | Same as a run; a message (`SendMessage`) flies as a paper plane | Not in our schema yet (gap) | Who coordinates whom |
| Skill | Binder on the room shelf | `Skill` call: character fetches the binder to the desk | Binder spine width = invocations by this planting (`care_card.size`) | Which skills matter |
| Playbook + gates | Floor route of numbered tiles with turnstiles | A run executing a playbook step lights its tile; a failed gate spec shuts the turnstile red | Turnstile = gate open / closed / unknown (`playbook.gate`) | Where the playbook breaks |
| Loop: agent tier (seconds) | The typing/reading cycle | One spark per tool call; the spark rate *is* the tool-call rate | Desk card: tier breakdown (`PlantView.tierBreakdown`) | Is it thrashing on tools? |
| Loop: verification (minutes) | QA bench in the room | Character walks to the bench for test/lint/typecheck, reviewer subagent, or hook; bench lamp green or red from the result's `is_error` / exit | Lamp strip = verification pass share in window (new metric, n + Wilson) | Tests flaky? Reviewer always rejecting? |
| Loop: application (hours) | Outbox by the door | Commit, push, or PR: character drops an envelope; a deploy rings a bell | Outbox pile = application events per day (log) | Is work shipping? |
| Loop: hill-climbing (days) | Notice board (CLAUDE.md, agents/, skills/, settings) | Editing a harness file: character pins a note; triggers the calendar flip | Days since last harness change; season count | Is anyone improving the harness? |
| Scheduled / automated loops (cron, `/loop`, headless, Stop-hook continuation) | Wall clock by the door | Clock dispatches a character at each run | Hand speed = runs/day (`irrigation.flow`); ringing + a queue at the door = flooding; stopped with cobweb = dry (`irrigation.state`); dashed clock = configured, not recorded (`irrigation.observed`) | Stop a runaway loop; revive a dead one |
| Connector / MCP | Wall jack + phone, labeled with the server name | Cable lights while an `mcp__<server>__*` call is in flight | Jack size = calls in window | Is the connector earning its slot? |
| Hooks | Door sensor / desk turnstile | Blink on a recorded hook (`stop_hook_summary`); `preventedContinuation` sends the character back to the desk with "!" | Dashed sensor = configured, not recorded | Is the guardrail actually firing? |
| Context fill & compaction | Paper stack on the desk + gauge under the label | Stack grows with fill (60/80/95 % thresholds); compaction = character feeds the shredder and the stack drops | Replay only (`ReplayView.frames.contextFill`) | Split the task, or trim context |
| Permission wait | Raised hand + amber "…" bubble | Stays until resolved; dashed outline if inferred; listed in the attention queue with wait time | Median permission wait per run (new, hooks only) | Approve now; add an allow rule |
| Waiting for input / done | Check bubble | Fades after 2 s; then the character idles at the desk | — | Answer it |
| Errors | Red puff from the monitor | One puff per `is_error` tool result | Red sticky notes = errors per run (bins) | Look at the failing tool |
| Cost | Coin counter on the character label | Live run cost (tokens × pricing, "est." when output is estimated) | Coin jar fill = median cost per run (5 bins; `plant.hue` data, new drawing) | Cheaper model / tighter prompt |
| Success rate (+ uncertainty) | Framed scorecard above the desk | A finished run drops a ✓ / ½ / ✗ tile on the card (heuristic, or manual with a pin icon) | Stars = success bins; hollow frame when n < 5; whisker = Wilson CI on hover; `n=` label (`plant.bloom`) | Trust it / read its failures |
| Recent failures | Potted plant on the desk | — | Droop = failure share, last 14 days (`plant.droop`) | Something recently broke |
| Staleness | Dust sheet over the desk | — | 14 d / 45 d thresholds (`plant.fade`) | Retire or revive |
| Weeds | Clutter | — | Unplugged monitor = orphan; twin nameplates = duplicate; unlabeled box = unowned (`weed.kind`) | Clean up |
| Ambient | Idle wander, pets | Random walk while done | "ambient, no meaning" | None |

Verdict: the live layer is excellent and instantly legible, and it matches what the community already
expects. The history layer feels bolted on: offices don't *grow*, so success, staleness, and runs become
props on desks that compete for 16 px. "Agent Garden" as a name and promise ("what's thriving, what's
wilting") gets lost.

### 4.B "Factory Floor": workshop, conveyors, QA station

One **hall** per harness family. One **machine** per planting. Each run is a **work-order crate** that moves
through belts. Strongest for loops and pipelines. Borrowed from Factorio and shapez.

| Concept | Element | Live layer | History layer | Action |
|---|---|---|---|---|
| Harness family | Factory hall | Hall lights / smoke while active | Floor plate color + label = model family; power-pole density = tools + MCP; spec sheet pinned at the entrance = CLAUDE.md bytes | Compare harnesses |
| Harness version | Machine model plate "Mk n" | Hill-climb edit: scaffold over the machine ("retooling"), plate increments | Seasons: Mk bands over time | Correlate retooling with yield |
| Agent (planting) | Assembler machine | Gears turn while a run is inside | Machine footprint = runs in window (log, 5 bins) | Load-bearing vs idle |
| Run | Crate entering at the input hopper | Human prompt drops a crate in; each tool call = one piston stroke; icon on the machine shows the tool family (magnifier, pencil, terminal, globe, chat) | — | What is in production now |
| Subagent | Side belt to another machine | Crate splits; a sub-crate rides to the child machine and returns as a component | Side-belt width = calls parent → child | Handoffs |
| Skill | Module in a machine slot | Slot glows on `Skill` call | Module size = invocations | Which modules earn their slot |
| Playbook + gates | Assembly line of machines with QC gates between | Crate advances machine to machine; a closed gate diverts it to a hold bay | Gate state | Where the line breaks |
| Loop: agent | Machine cycle | Piston strokes = tool calls | Tier breakdown | Thrashing? |
| Loop: verification | QA scanner arch on the output belt | Pass: green flash, crate continues. Fail: red, crate rides the **rework belt** back to the input (one rework loop per failed verification) | **First-pass yield** = share of runs whose first verification passed (new metric, Wilson); rework loops per run | Fix tests or the agent's checks |
| Loop: application | Shipping dock + truck | Commit/push/PR loads a crate on the truck; deploy drives it off | Shipments per day | Is work leaving the building? |
| Loop: hill-climbing | Engineering office with a blueprint table | Harness edit: engineer walks from the office to the machine | Days since last retool | Is anyone improving the line? |
| Scheduled loops | Timed spawner at the hall entrance feeding a belt | Emits a crate per run | Belt speed + crate density = runs/day (Vizceral-style); **backed-up belt** + "output full" alert = flooding; empty belt + "no input" alert = dry; dashed belt = unobserved | Stop runaway, revive dead |
| Connector / MCP | Pipe from outside the hall wall | Fluid pulses during a call | Pipe diameter = calls | Unused supply lines |
| Hooks | Sensor/inserter on a belt (circuit network) | Blinks on a recorded hook; a blocking Stop hook pushes the crate back | Dashed = configured, not recorded | Guardrail firing? |
| Context fill & compaction | Machine's input buffer gauge | Buffer fills; compaction = compactor press crushes it down | Replay only | Split the job |
| Permission wait | Machine halted with an operator-hand alert icon | Flashing until resolved; dashed if inferred | Median wait (hooks) | Approve / allow-rule |
| Errors | Sparks + scrap bin next to the machine | Spark per error; scrap piece drops | Scrap per run | Debug the tool |
| Cost | **Power meter** | Live draw in $/h from token rate × pricing | Machine power rating badge = median cost/run (5 bins); hall bill = total | Cheaper model |
| Success rate | Output bins: good / partial / scrap | Finished crate lands in a bin (manual-labelled crates carry a tag) | Yield % with Wilson bar and `n=`; hollow when n < 5 | Trust / investigate |
| Recent failures | Warning stripes + smoke | — | Failure share 14 d | Recently broke |
| Staleness | Rust, powered down | — | 14 / 45 d | Retire |
| Weeds | Disconnected machine (orphan), duplicate recipe (duplicate), unlabeled crate (unowned) | — | `weed.kind` | Clean up |
| Ambient | Conveyor idle shimmer | — | "ambient, no meaning" | None |

Verdict: the best vocabulary for **loops, verification, rework, shipping, and runaway detection**. It makes
the four-tier loop model physical. The costs: it reads as industrial, not personal; belt routing is a
real layout problem; and the "agent" (a reasoning thing) becomes a machine, which undersells it.

### 4.C "Control Room": radar + flight strips (the professional option)

One **sector** per harness family on a calm radar scope. Each run is an **aircraft**. A strip board
(DOM) lists every run by state. Borrowed from ATC flight progress strips and kube-ops-view.

| Concept | Element | Live layer | History layer | Action |
|---|---|---|---|---|
| Harness family | Sector on the scope + strip-board column | Sector outline brightens with traffic | Sector label = model family; beacon count = tools + MCP; NOTAM length = CLAUDE.md bytes | Compare harnesses |
| Harness version | NOTAM / sector chart revision | New revision marker on a hill-climb edit | Revision bands on a time axis | Correlate |
| Agent (planting) | Fixed beacon in the sector | Beacon pulses when it has a flight | Beacon size = runs; block grid (kube-ops-view) = one square per run colored by outcome | Load-bearing / unused |
| Run | Aircraft blip + flight strip | Blip moves inward from the edge toward its beacon; the strip moves bays: *pending → active → holding → landed* | — | Triage |
| Subagent | Child strip indented under the parent; small blip trailing | Appears / lands | Handoff edges between beacons | Handoffs |
| Skill | Procedure card attached to a strip | Card attaches on call | Card usage counts | Which skills matter |
| Playbook | Published route with checkpoints | Blip passes checkpoints; failed gate = a hold at that checkpoint | Gate state | Where it breaks |
| Loop tiers | Rings on the scope: inner = agent (seconds), then verification, application, hill-climbing (outer, days) | Each step blips on the ring of its tier | Ring density = steps per tier | Where effort goes |
| Scheduled loops | Departure board (timetable) | Departure posted per run | Cadence; "DELAYED" = dry; stacked holding pattern = flooding | Runaway / dead |
| MCP | External radio frequencies | Frequency lights during a call | Calls per frequency | Unused connectors |
| Hooks | Clearance stamps on the strip | Stamp on a recorded hook; blocked = "RETURN" | — | Guardrails |
| Context fill | Fuel-style bar on the strip (labeled "context") | Bar level; compaction = refuel marker | Replay | Split the job |
| Permission wait | Strip in the **HOLD** bay, sorted by wait time, blinking | Until resolved; italic if inferred | Median hold time | Approve |
| Errors | Strip red flag count | Increments live | Errors per run | Debug |
| Cost | Fuel-burn counter on the strip | Live $ | Median cost per run | Cheaper model |
| Success | On-time arrival rate per beacon | Landed strip stamped ✓ / ½ / ✗ | Rate + Wilson + `n=` | Trust |
| Staleness / weeds | Mothballed beacons; unassigned callsigns | — | Lists | Clean up |

Verdict: the most information-dense and the most accessible (it is mostly a table). It answers
"which agent needs me now" better than anything else. It has no charm, no "garden" identity, and
looks like every ops dashboard. **Steal the strip board (the attention queue) for whichever option we pick.**

### 4.D "Pixel Homestead": garden for history, gardeners for live (recommended hybrid)

Keep the garden: beds = harness families, plants = plantings, and every encoding in `encodings.ts` stays.
Re-render it in procedural pixel art on a 16 px tile grid. Then add the live layer as **gardeners**: one
character per active run, who walks to *the plant they are running* and works it. Each bed gets three
stations at its edge: an **inspection table** (verification), a **shipping bin** (application, after
Stardew), and a **toolshed with an almanac** (hill-climbing / harness). The plant *is* the desk, so the
live layer lands exactly on the history glyph it will update.

| Concept | Element | Live layer | History layer | Action |
|---|---|---|---|---|
| Harness family | Bed (pixel plot with edging + label) | Gate lantern lit while any run in the bed is active | Edging color + label = model family (`bed.tone`); soil speckle density = tools + MCP (`bed.texture`); strata rows at the bed's front edge = CLAUDE.md bytes (`bed.strata`) | Compare harnesses |
| Harness version | Almanac page in the toolshed; season bands | Hill-climb edit: gardener writes in the almanac, the page flips, and plants run next get a 1-run "new season" tag | Seasons view bands (`season.band`) | Correlate (and say it is correlation) |
| Agent (planting) | Plant | Plant brightens / outlines while a run of it is active | Height = runs (`plant.height`); bloom = success with hollow bud at n < 5 (`plant.bloom`); droop = 14-d failure share (`plant.droop`); fade = staleness (`plant.fade`); foliage = median cost (`plant.hue`) | As today |
| Run (main thread) | Gardener (16×24, shirt = model-family color, hat = agent kind) | Appears at the bed gate on a human prompt and walks to its plant. Tool families get distinct poses: **watering can** = Edit/Write/NotebookEdit, **magnifier** = Read/Grep/Glob, **hoe** = Bash, **lantern** = WebFetch/WebSearch, **speaking tube** = `mcp__*`. One sparkle per tool call. Leaves at run end | — | What is running now |
| Subagent | Bee (already our handoff glyph), carrying the child's type badge | Bee flies from the parent gardener to the child plant; a helper gardener (half size) works there; the bee returns on finish | Bee count on a path = calls (`bee.count`) | Handoffs |
| Teammate | Full gardener with a team ribbon; lead has a straw-hat band | As a run; `SendMessage` = a bee carrying a letter | Schema gap (see §7) | Coordination |
| Skill | Seed packet (care card) | `Skill` call: gardener pulls the packet from its pocket; the packet flashes | Packet size = invocations (`care_card.size`) | Which skills matter |
| Playbook + gates | Stepping stones + gates across beds | The active step's stone lights; a failed gate spec closes the gate (red, with icon) | Gate state (`playbook.gate`) | Where it breaks |
| Loop: agent | Gardener's working cycle | One sparkle per tool call; reading vs writing poses | Plant card tier breakdown | Thrashing? |
| Loop: verification | Inspection table at the bed edge | Gardener carries a sample to the table for test/lint/typecheck/reviewer/hook; result lamp green/red with ✓/✗ icon | Table tally = verification pass share (new, Wilson + n) | Flaky tests / harsh reviewer |
| Loop: application | Shipping bin at the bed gate | Commit/push/PR: gardener drops a crate in the bin; a deploy rings the bell | Bin tally = application events/day | Is work shipping? |
| Loop: hill-climbing | Toolshed + almanac | Harness-file edit: gardener goes into the shed; the almanac page flips | Days since last harness change, season count | Is anyone improving the harness? |
| Scheduled / automated loops | Irrigation channels from a **water tower with a timer** (cron, `/loop`, headless repeats, Stop-hook continuations) | Water pulse per loop run; a timer-dispatched gardener arrives along the channel | Flow speed/width = runs/day (`irrigation.flow`); flooding / dry (`irrigation.state`); dotted = unobserved (`irrigation.observed`) | Stop runaway, revive dead |
| Connector / MCP | Well / pipe entering through the fence, labeled with the server name | Pipe pulses during a call | Pipe thickness = calls; unused well = orphan weed | Is the connector earning its slot? |
| Hooks | Sluice gate on the channel / gate latch | Latch blinks on a recorded hook; blocking Stop hook = gardener turned back at the gate with "!" | Dotted latch = configured, not recorded | Guardrail firing? |
| Context fill & compaction | Gardener's basket (+ 40×4 gauge under the nameplate) | Basket fills (60/80/95 %); compaction = gardener empties it into the **compost bin**, and the bin counts compactions | Replay view frames | Split the task |
| Permission wait | Gardener stops and raises a hand; amber "…" bubble | Persists; dashed outline if inferred; also in the DOM attention queue (strip-board style) with wait time | Median permission wait per run (hooks only) | Approve; add an allow rule |
| Waiting for input / done | Check bubble; gardener sits on the bed edge | Fades after 2 s | — | Answer it |
| Errors | Thorn burst at the plant | One burst per `is_error` result | Errors/run on the plant card; droop already carries recent failure | Debug |
| Cost | Coin pouch tally on the nameplate | Live run cost ("est." when output tokens are estimated) | Foliage color = median cost/run (`plant.hue`) | Cheaper model |
| Billing window (optional, from ccusage) | Sun position over the field | Sun arc = share of the current 5-hour block elapsed; field tint = tokens burned in the block | — | Pace yourself |
| Success rate (+ uncertainty) | Bloom | On run end the outcome appears as a petal opening (✓), half petal (½), or dropped petal (✗); a pin when the label is manual | Bloom bins, hollow bud n < 5, Wilson CI and `n=` in "how computed" | Trust / read failures |
| Staleness | Fade, dry tips | — | `plant.fade` | Retire / revive |
| Weeds | Weeds | — | `weed.kind` | Pull them |
| Ambient | Sway, gardener idle shuffle, butterflies | — | "ambient, no meaning", disabled by reduced motion | None |

Why this works: the live layer answers "what is happening and who needs me". The history layer answers
"what is thriving and what is wilting". **They share coordinates**: a gardener stands at the plant it's
about to change, and the finished run's petal lands on that plant's bloom. The name, the vocabulary, the
registry, the contracts, and M3–M4 all survive.

---

## 5. Recommendation

**Build 4.D, "Pixel Homestead".** Steal three things: the factory's loop/QA vocabulary (inspection table,
rework, shipping, backed-up and empty channels with alert icons), the control room's attention queue
(DOM strip board, sorted by wait), and Pixel Agents' live-state rules (tool-family poses, persistent
permission bubble, fading done-bubble, context level not total, sub-agent near its parent).

Reasoning:

1. **The mapping rule favors growth metaphors for history.** Plants already encode five metrics
   naturally: height, bloom, droop, fade, foliage. An office has no native channel for "thriving" or
   "wilting". The 4.A table shows it: every history metric becomes a desk prop competing for pixels.
2. **Live favors characters.** Every Claude Code visualizer that people use converged on one character per
   session with tool poses and bubbles (§2). Users will expect it. Gardeners give us that without
   giving up the garden.
3. **Shared coordinates are the differentiator.** No reference connects "what is happening now" to "how
   this agent has done over time". In 4.D, the live event lands on the history glyph it will update.
4. **It protects what is built.** `GardenView`, `PlantView`, `ReplayView`, the encodings registry, the legend,
   genotype caching, and the layout's shared-slot rule all carry over. The work is additive: a live contract, a
   tailer, an SSE endpoint, a sprite kit, and a re-skin.
5. **The art problem goes away.** Procedural palette-grid sprites mean no third-party art and no
   licensing doubt. Palettes stay validated, and plant sprites keep generating from metrics.

Alternatives, if you prefer:
- **Pixel Studio + garden as two separate views** ("Now" office, "History" garden). It's easy to explain, but
  it doubles the layout work (an office layout editor is a big feature in Pixel Agents) and loses the
  shared coordinates.
- **Factory Floor everywhere.** Choose it if loops and pipelines, not agents, are the main story you want
  to tell, for example if most of your usage is headless/cron loops. It is the strongest for runaway-loop
  detection and verification yield.
- **Control Room.** Choose it if you value density and accessibility over identity. Either way, its strip
  board should ship as the DOM panel of whichever option wins.

Risks: (a) legibility at 16 px. Bloom needs 5 distinguishable levels plus a hollow bud. Budget plant
sprites at 16×32 to 32×48 and verify with screenshots at 2× and 3× zoom. (b) Motion overload with many
concurrent runs. Cap visible gardeners per bed (for example 4, then a "+3" badge) and keep sparkles small.
(c) Inferred states. Permission waits from transcript silence will be wrong sometimes, so draw them as
inferred and make hooks a clearly explained opt-in.

---

## 6. Implementation sketch (our stack)

### 6.1 Data contracts: what carries over

| Existing contract (`views.ts`) | Pixel Studio | Factory | Control Room | Homestead (rec.) |
|---|---|---|---|---|
| `GardenView.beds` / `BedSummary.soil` | rooms, wall props | halls | sectors | beds (unchanged) |
| `GardenView.plants` / `PlantSummary` | desks + props | machines | beacons + block grid | plants (unchanged) |
| `skills` / `SkillCard` | binders | modules | procedure cards | seed packets |
| `loops` / `LoopChannel` | wall clocks | belts + spawners | departure board | irrigation + water tower |
| `bees` / `BeeFlow` | carpet paths | side belts | handoff edges | bees |
| `weeds` / `Weed` | clutter | disconnected machines | mothballed beacons | weeds |
| `playbooks` / `PlaybookPath` | floor route | assembly line | published route | stepping stones |
| `PlantView` | desk inspector | machine panel | beacon panel | plant panel (unchanged) |
| `ReplayView.frames` | character replay | crate replay | strip replay | gardener replay (same renderer as live) |
| `SeasonsView` | calendar | Mk plates | chart revisions | season bands (unchanged) |
| `RouterResult` | highlighted desk | highlighted machine | highlighted beacon | highlighted plant, gardener points at it |

What's new is a live contract. `ReplayFrame` already has most of the per-step shape, so live events should
extend it, letting **one renderer play both live and replay**:

```ts
// packages/core/src/live.ts (sketch)
export type LiveSource = 'hook' | 'transcript' | 'inferred';
export type LiveStatus = 'active' | 'permission' | 'waiting_input' | 'done';

export interface LiveRun {
  runId: ID; sessionId: ID; plantId: ID; bedId: ID;
  agentKind: 'main' | 'subagent'; parentRunId?: ID;
  status: LiveStatus; statusSource: LiveSource; statusSince: ISO;
  activity: { kind: StepKind; tier: LoopTier; toolFamily: ToolFamily; label: string } | null; // label is a RedactedText preview
  contextFill: number | null; compactions: number;
  tokensCum: number; costUsd: number | null; costEstimated: boolean; // cost computed at query time
  errors: number; startedAt: ISO; lastEventAt: ISO;
}
export interface LiveSnapshot { seq: number; generatedAt: ISO; runs: LiveRun[]; loopsDue: { loopId: ID; dueAt: ISO }[] }
export type LiveEvent =
  | { seq: number; type: 'run.start' | 'run.update' | 'run.end'; run: LiveRun; outcome?: RunRow['outcome'] }
  | { seq: number; type: 'step'; runId: ID; frame: ReplayFrame; toolFamily: ToolFamily }
  | { seq: number; type: 'harness.changed'; bedId: ID; harnessVersionId: ID }
  | { seq: number; type: 'loop.tick'; loopId: ID };
export function applyLiveEvent(s: LiveSnapshot, e: LiveEvent): LiveSnapshot; // pure, unit-tested
```

Encodings: add `GardenElement` values `'gardener' | 'station' | 'bubble'` and registry entries for
each live channel (pose = tool family, bubble = status, dashed = inferred source, basket = context fill,
compost = compactions, sparkle = tool call, thorn = error, inspection lamp, shipping bin). The legend
picks them up automatically, so a live channel can't exist without a legend row.

### 6.2 Pipeline

1. **Tailer** (`packages/ingest/src/live/tail.ts`): reuse the incremental ingestion (path, size, mtime,
   byte offset). Use `fs.watch` with a 500 ms poll fallback and partial-line buffering, like Pixel
   Agents. New lines go through the same parser, then `redact()`, then the store, and *then* get emitted on
   an in-process bus as `LiveEvent`s. Only already-redacted data reaches the bus. The permission
   inference timer (7 s after a non-exempt tool with no new data) emits `status: 'permission',
   statusSource: 'inferred'`.
2. **Server**: `GET /api/live` as **SSE** (Hono `streamSSE`) on `127.0.0.1`. It is one-way, so we don't need
   WebSocket. It sends a snapshot first, then deltas with `seq`. On reconnect the client sends
   `Last-Event-ID` and gets a fresh snapshot if the gap is too large. Add a heartbeat every 15 s.
3. **Hooks (later, opt-in)**: `POST /api/hooks` with a bearer token from `~/.agent-garden/token`. The body is
   zod-parsed, reduced to the allowlisted fields, and redacted on receipt. The installer gets
   explicit consent, makes a backup, and writes atomically. It never installs `UserPromptSubmit`. Our hook entry
   is recognized by identity and **excluded from harness fingerprints and weeds**.
4. **Demo**: `scripts/demo --live` appends synthetic JSONL lines over time in real formats, in the same
   spirit as Pixel Agents' `mock-claude` scenario runner (`at(ms).appendJsonl(record)`). That lets
   Playwright and the demo exercise the real path.

### 6.3 Renderer: procedural pixel sprites in PixiJS 8

- **Sprite kit as palette-index grids in code.** Each sprite is a list of strings where each character
  indexes a *role* palette (outline, skin, shirt, accent, ...). The shirt role is filled with the
  validated model-family color, so one grid plus one palette per family gives every variant without
  hue-shifting at random.

  ```ts
  // apps/web/src/garden/pixel/sprites.ts (sketch)
  export interface SpriteGrid { w: number; h: number; rows: readonly string[] } // '.' = transparent
  export const GARDENER_DOWN_0: SpriteGrid = { w: 16, h: 24, rows: [
    '......1111......',
    '.....122221.....',
    // ... 22 more rows
  ] };
  export type RolePalette = readonly (string | null)[]; // index by digit/letter; filled from palette.ts
  ```

- **Bake once, cache by key.** `bake(grid, palette) → Texture` writes RGBA into a `Uint8Array`, wraps it as a
  buffer-backed texture source (or draws into an `OffscreenCanvas` and uses `Texture.from(canvas)`), and sets
  `scaleMode: 'nearest'`. Cache by `spriteId:paletteKey:frame`. Plants keep today's approach: the genotype
  bucket becomes a deterministic pixel grid generator, and textures are cached by genotype. Confirm the exact
  Pixi 8 texture-source API when building. The canvas path is the safe fallback.
- **Pixel-perfect camera.** Integer zoom only (Pixel Agents uses 1×–10×, default `round(2 × dpr)`). Set
  `roundPixels: true` and `TextureStyle.defaultOptions.scaleMode = 'nearest'`. Use 16 px tiles. Z-order by
  y using `zIndex` in a sortable container per bed.
- **Gardener FSM** (imperative, in the Pixi ticker, never in React): `enter → walk → work(pose) → walkTo(station)
  → work → … → exit`. Use BFS on the tile grid (paths between beds are walkable tiles), with targets from
  `LiveRun.activity` (plant, inspection table, shipping bin, toolshed). Keep at least 300 ms in each pose so
  brief tools stay visible (Pixel Agents' `TOOL_DONE_DELAY_MS`).
- **React** owns the DOM chrome. It gets a throttled (about 4 Hz) projection of `LiveSnapshot` for the attention
  queue (strip board: runs in `permission` / `waiting_input`, sorted by `statusSince`), the legend, and
  the `T` table, which gains a "Now" tab.
- **Reduced motion.** Gardeners snap to targets with no walking. Poses become static icons. Sparkles become a
  per-plant counter. Bubbles stay, because they carry state.
- **Fonts.** A self-hosted pixel font for in-world labels, for example `@fontsource/silkscreen` or
  `@fontsource/pixelify-sans` (both 5.3.0, OFL-1.1 on npm today). Keep Fraunces / Source Sans for DOM
  panels, or switch fully if we re-skin.
- **Palette.** The new surface (a darker soil or grass tile) changes contrast. Re-run the dataviz validator for
  foliage ordinal, model-family categorical, and status colors against it, and record the results in
  `docs/design.md`.

### 6.4 Suggested milestones (if approved)

| Step | Scope | Verification |
|---|---|---|
| L1 | `live.ts` contract + `applyLiveEvent` + encodings entries; tailer → bus → SSE; `--live` demo | Reducer unit tests; golden event stream from a synthetic appended JSONL; redaction proof covers bus output |
| L2 | Pixel sprite kit + gardeners over the *current* garden (no re-skin yet); attention queue panel | Playwright screenshots with live demo frames; legend lists every live channel; reduced-motion snapshot |
| L3 | Stations (inspection table, shipping bin, toolshed) + compost/basket + bubbles with inferred styling | Screenshot per station; step-tier classifier tests reused |
| L4 | Re-skin garden to pixel plants (genotype → grid), beds, irrigation, bees, weeds | Existing encoding tests pass; screenshots checked against the mapping table |
| L5 | Opt-in hooks receiver + installer with consent, backup, fingerprint exclusion | Installer tests (atomic write, backup, uninstall); fingerprint unchanged after install; payload allowlist test |

---

## 7. Open questions and gaps

- **Teammates (Agent Teams)** are not in our schema. A named background agent with its own top-level
  session needs a decision. Probably a planting of its agent type in the same bed, with a `leadRunId` link.
- **Permission waits** are not in transcripts. Without hooks they are always inferred. Is an opt-in hook
  install acceptable to you, given it edits `~/.claude/settings.json`?
- **`turn_duration`, `progress` records, and `compact_boundary`** are reported by others but not yet
  observed by us. Add fixtures before relying on them (data-format discipline).
- **New history metrics** proposed here (verification pass share, first-pass yield, application events per
  day, median permission wait) need definitions in `docs/schema.md` and heuristics tests before any
  channel shows them.
- **Billing window** (5-hour block) needs a verified source for block boundaries before it gets a channel.
