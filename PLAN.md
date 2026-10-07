# PLAN.md: Agent Garden v1

> "See every AI agent you run as a living garden: what's thriving, what's wilting, and which one to call."
> Prompts are seeds. Harnesses are soil. Loops are seasons.

Status: **M0 (this plan), waiting for approval.** No application code is written until you approve.
Verified external facts are in [`docs/sources.md`](docs/sources.md). Conventions are in [`CLAUDE.md`](CLAUDE.md).

---

## 1. Assumptions (stated so you can veto them)

1. **I am in a cloud container, not on your machine.** Your `~/.claude` is not here. I verified formats
   against what this container really has: a live Claude Code v2.1.293 session transcript, skills,
   hook config, and the official docs. Your data may come from other Claude Code versions, so the first
   thing you run locally is `pnpm garden inspect`. It prints a census of what it found (record
   types, unknown fields, versions, counts) and never prints content.
2. **Run granularity.** For the main thread, a run is one human prompt plus all agent work until
   the next human prompt. For a subagent, a run is one invocation. A session (one transcript file) groups runs.
   This makes "user immediately retried" a usable success signal.
3. **Bed = harness family = one project directory** (project config merged with your user-level
   config). Changes to that harness over time are its **seasons**. The same agent (for example `main`, or a custom
   `test-writer` subagent) planted in two projects shows up as two plants in two beds. That is the demo moment.
4. **The demo dataset is synthetic.** A deterministic generator writes files in real Claude Code
   formats (JSONL transcripts, `agents/*.md`, `SKILL.md`, `settings.json`, git history), so the demo
   goes through the same ingestion path as real data. No slice of your data is used.
5. **Router embeddings are local and offline by default** (TF-IDF + LSA vectors computed on your machine).
   Neural embeddings (MiniLM via transformers.js) are opt-in with a one-time model download to your
   machine. Hugging Face is blocked by this container's network policy, so I cannot test that path here.
6. **Store = Node's built-in `node:sqlite`.** No native build step, which helps the 5-command setup.
   DuckDB stays an option if analytics outgrow SQLite.
7. **Costs** are computed in USD from a versioned local pricing table. Tokens are stored. Dollar
   amounts are derived at query time.

### Non-blocking questions (defaults above apply unless you say otherwise)

1. Is the run granularity in (2) right for how you work?
2. In your two other side projects, are `CLAUDE.md` and `.claude/` committed to git? Seasons gets much
   richer with git history. Without it I fall back to harness changes observed in transcripts.
3. Do you want a static hosted demo (GitHub Pages, built from the demo dataset) as part of M8?
4. Opt-in neural embeddings OK, or keep it strictly lexical/offline?
5. Visual direction: I propose a **botanical field guide** look: warm paper background, ink-line
   procedural plants, a muted palette, calm motion. A "night garden" theme could come later. Any objection?

---

## 2. What the data actually gives us (verified, details in docs/sources.md)

Facts from a real transcript (`~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl`, CC 2.1.293):

- Line types seen: `user`, `assistant`, `attachment`, `queue-operation`, `last-prompt`, `atis-latch`.
  Lines link through `uuid` / `parentUuid`. Each line has `sessionId`, `cwd`, `gitBranch`, `version`,
  `entrypoint`, `isSidechain`, and `timestamp`.
- **One API response is split across several lines (one per content block) and every line repeats the
  full `usage`.** I observed 1–3 lines per `message.id`. Summing per line overcounts tokens 2–3×. We dedupe by `message.id`.
- `usage` has `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
  a split into `ephemeral_5m`/`ephemeral_1h`, and `output_tokens_details.thinking_tokens`. That is
  enough for cost and context-window fill per call.
- **The transcript records the harness the model saw**, as attachments: `skill_listing.names`,
  `agent_listing_delta.addedTypes`, `mcp_instructions_delta.addedNames`, and `deferred_tools_delta.addedNames`.
  It also records `permissionMode` on user lines and `effort` on assistant lines. So we can fingerprint
  harness versions even when config files aren't in git.
- Tool calls are `tool_use` blocks (`name`, `input`, `id`). Results are `tool_result` blocks
  (`is_error`, `content` string or list), with a structured `toolUseResult` on the user line (for
  example Bash: `stdout`, `stderr`, `interrupted`).
- User prompts carry `origin.kind` (`human` observed), which helps tell human turns from automated
  ones. Other values are not yet verified.
- A skill's directory name can differ from its frontmatter `name`: `session-start-hook/` declares
  `name: startup-hook-skill`. Identity must handle both.

Not yet verified on a real file (the parser stays tolerant, and fixtures get added when seen): compaction
records, separate subagent transcript files vs inline sidechains, and hook-execution records. The
docs check in `docs/sources.md` covers what the official docs say about each.

---

## 3. Architecture

```
 ~/.claude/projects/**.jsonl ─┐
 agents/*.md, skills/**/SKILL.md ─┤   ┌──────────── packages/ingest ─────────────┐
 settings*.json (hooks, perms) ─┼──▶│ Adapter(s) ─▶ redact() ─▶ normalize ─▶ store│──▶ garden.db (SQLite, local)
 .mcp.json, ~/.claude.json (keys)─┤   │  claude-code  │ RedactedText only    ▲      │
 git log of harness files ──────┘   │  (otel, ...)   └ heuristics, loops, weeds│      │
 garden.yaml (playbooks, loops) ───▶└──────────────────────────────────────────┘      │
                                                                                       ▼
 apps/web (React + PixiJS) ◀── view contracts (JSON) ◀── packages/server (Hono, 127.0.0.1) ◀── packages/router
           ▲                                   └── `garden export --static` → JSON files for a hosted demo
```

- **Ingestion is incremental**: it tracks file path, size, mtime, and byte offset. History that Claude Code
  later deletes (transcript retention) stays in `garden.db`.
- **The view contracts** (§7) are the only thing the web app knows about. They are built by pure
  functions in `packages/core`, so the server and the static export share code.

---

## 4. Stack decisions

| Decision | Choice | Why | Rejected |
|---|---|---|---|
| Language | TypeScript (strict, ESM) everywhere | One schema type system from ingestion to pixels | — |
| Workspace | pnpm workspaces (pnpm 10.28 present) | Clear package boundaries let subagents work in parallel | Single package (boundaries blur) |
| Store | `node:sqlite` (SQLite 3.50.4 in Node 22.22, verified working) | Zero native deps, transactional, plenty for ~10⁵ steps | better-sqlite3 (native build, can fail on install), DuckDB (heavier, overkill for v1) |
| Validation | zod 4 at IO boundaries | Tolerant parsing with explicit unknown-field accounting | Hand-rolled guards |
| Local API | Hono + @hono/node-server, bound to 127.0.0.1 | Tiny, typed, serves API and built web app from one process | Fastify (heavier), Vite middleware only (no prod build) |
| Frontend | React 19 + Vite | Standard, fast HMR. React handles DOM chrome only | Next.js (server features unneeded) |
| Garden renderer | **PixiJS v8, imperative**, hosted in a React component | See below | Canvas2D, SVG/D3, Three.js, @pixi/react |
| Small charts | Inline SVG (sparklines, CI bars in panels) | Crisp, accessible, few nodes | Charting library (weight, generic look) |
| Tests | Vitest (unit, golden, redaction proof); Playwright for screenshots | Fast. Playwright pinned to 1.56.x to match the preinstalled Chromium here | Jest |
| Embeddings | `Embedder` interface. Default local TF-IDF+LSA; opt-in MiniLM (transformers.js) | Works offline and in CI; honest about which method ranked | Remote embedding APIs (data would leave the machine) |
| Fonts | Self-hosted via @fontsource (serif display + humanist sans) | No CDN calls, crafted feel | Google Fonts CDN |

Versions checked on npm today (2026-10-07): pixi.js 8.22.0, react 19.3.0, vite 8.3.3, vitest 5.0.3,
zod 4.6.5, hono 4.13.13, typescript 7.0.2. TypeScript 7 is the native port. I'll pin 7.x at M1 if
typescript-eslint supports it, otherwise 6.x.

**Renderer justification.** The garden needs a few hundred plants with ambient sway, flowing irrigation,
bees in flight, semantic zoom, and a time-lapse that grows a plant step by step, at 60 fps on a laptop.
- *PixiJS v8* batches sprites on WebGL2 (WebGPU optional). Each plant's geometry is generated procedurally
  from its metrics, rasterized once into a cached texture keyed by its encoding "genotype" bucket, and
  reused. That keeps draw calls low with 500+ plants. It also has a scene graph with pointer hit-testing,
  particle containers for bees and water, and BitmapText for labels. MIT licensed and actively maintained.
- *Canvas2D* redraws every bezier stem on the CPU every frame. It's fine for a static picture, but sway,
  time-lapse, and season scrubbing would cost several ms per frame on hi-DPI screens.
- *SVG/D3* is crisp and accessible, but 300 plants × ~30 nodes ≈ 9k animated DOM nodes means layout
  and paint jank. I keep SVG for small panel charts.
- *Three.js* adds a camera and depth that hurt the "calm, readable map" goal.
- *@pixi/react* routes per-frame updates through React reconciliation. I keep React out of the hot path.
- **Accessibility:** every view has a DOM table equivalent (toggle `T`), plus keyboard focus that moves
  across plants with a DOM focus ring overlaid on the canvas.

---

## 5. Domain mapping: Claude Code → schema

| Schema entity | Claude Code source |
|---|---|
| Agent | `main` thread (`isSidechain: false`), and each subagent type from Agent/Task `tool_use.input.subagent_type`, joined to its definition in `~/.claude/agents`, `.claude/agents`, plugins, or built-ins |
| HarnessFamily (bed) | Project root (from `cwd` / git root) |
| HarnessVersion (season) | Hash of the canonical harness bundle: model, effort, permission mode, CLAUDE.md chain hashes, tool/skill/subagent/MCP listings (from transcript attachments), hooks, settings hash. Provenance: `git` (commit of a harness file), `observed` (fingerprint change in transcripts), or `snapshot` (current files) |
| Skill | `SKILL.md` in user, project, and plugin scopes. Invocations are `Skill` tool calls. Availability comes from `skill_listing` |
| Playbook | Declared in `garden.yaml` (steps → skill/agent, gates) |
| Loop | Hooks in `settings*.json` (verification machinery); `/loop` and `CronCreate` calls; repeated headless sessions (non-interactive `entrypoint`, similar prompt fingerprint, regular cadence); Stop-hook continuations; plus anything declared in `garden.yaml` |
| Run / Step | Transcript lines grouped as in §1.2 |
| Outcome | Heuristics (§6.3) plus manual labels |
| Cost/Tokens | Deduped `usage` per `message.id` × pricing table |
| Connector | MCP servers from `.mcp.json`, `~/.claude.json` (names only), and `mcp__<server>__<tool>` call names |

Every step also gets a **loop tier**. That gives the four nested loops a concrete, data-derived meaning:
- `agent`: ordinary tool calls and messages.
- `verification`: test, lint, and typecheck commands; reviewer subagents; hook executions.
- `application`: `git commit`/`push`, PR creation, deploy commands.
- `hill_climbing`: edits to CLAUDE.md, `agents/`, `skills/`, `settings.json`, `.mcp.json`.

---

## 6. Schema draft (finalized in docs/schema.md at M1)

```ts
type ID = string;            // stable, content- or path-derived hash
type ISO = string;           // timestamp
type RedactedText = string & { readonly __brand: 'RedactedText' }; // only redact() can create one
type LoopTier = 'agent' | 'verification' | 'application' | 'hill_climbing';

interface Source { id: ID; adapter: 'claude-code' | (string & {}); root: RedactedText; adapterVersion: string }

interface Agent {
  id: ID; name: string;                                  // 'main', 'Explore', 'test-writer'
  kind: 'main' | 'subagent';
  definition?: { scope: 'user' | 'project' | 'plugin' | 'builtin'; path?: RedactedText;
                 description?: RedactedText; tools?: string[]; model?: string; contentHash: string };
  firstSeenAt: ISO; lastSeenAt: ISO;
}

interface HarnessFamily { id: ID; name: string; projectRoot: RedactedText }   // a bed

interface HarnessVersion {                                // a season of a bed
  id: ID; familyId: ID; validFrom: ISO; validTo?: ISO;
  provenance: 'git' | 'observed' | 'snapshot';
  bundle: {
    model?: string; effort?: string; permissionMode?: string; entrypoint?: string;
    instructions: { path: RedactedText; hash: string; bytes: number }[];   // CLAUDE.md chain
    tools: string[]; skills: ID[]; subagents: ID[]; mcpServers: string[];
    hooks: { event: string; matcher?: string; commandHash: string }[];
    settingsHash?: string;
  };
  commit?: { sha: string; message: RedactedText };
  diffFromPrevious?: HarnessDiff;                          // added/removed tools, skills, model change, instruction line deltas
}

interface Skill { id: ID; name: string; dirName: string; scope: 'user' | 'project' | 'plugin';
                  path: RedactedText; description?: RedactedText; contentHash: string }

interface Playbook { id: ID; name: string; source: 'garden.yaml';
                     steps: { id: string; skillId?: ID; agentId?: ID; gate: GateSpec }[] }
type GateSpec = { kind: 'step_success' } | { kind: 'tests_pass' } | { kind: 'command_ok'; pattern: string } | { kind: 'manual' };

interface Loop {
  id: ID; name: string; tier: LoopTier; provenance: 'declared' | 'config' | 'inferred';
  trigger: { kind: 'hook' | 'cron' | 'loop_skill' | 'headless_repeat' | 'stop_continuation' | 'declared'; detail: RedactedText };
  expectedIntervalSec?: number;
  targets: { agentIds: ID[]; familyIds: ID[] };
}

interface Session { id: ID; sourceId: ID; familyId: ID; path: RedactedText; cliVersion?: string;
                    entrypoint?: string; gitBranch?: string; startedAt: ISO; endedAt: ISO }

interface Run {
  id: ID; sessionId: ID; agentId: ID; familyId: ID; harnessVersionId: ID;
  parentRunId?: ID; parentStepId?: ID; loopId?: ID;
  startedAt: ISO; endedAt: ISO; trigger: 'human' | 'automated' | 'subagent';
  taskPreview: RedactedText;                              // first prompt, truncated
  models: string[]; tokens: TokenUsage;                   // deduped by API message id
  stepCount: number; toolCallCount: number; errorCount: number;
  compactionCount: number; peakContextTokens: number;
}

interface Step {
  id: ID; runId: ID; seq: number; at: ISO; loopTier: LoopTier;
  kind: 'user_message' | 'assistant_message' | 'thinking' | 'tool_call' | 'tool_result'
      | 'subagent_spawn' | 'subagent_return' | 'compaction' | 'error' | 'hook';
  preview?: RedactedText;                                  // truncated; thinking keeps length only
  tool?: { name: string; callId: string; category: 'builtin' | 'mcp' | 'skill' | 'subagent';
           mcpServer?: string; skillId?: ID; isError?: boolean };
  apiMessageId?: string; tokens?: TokenUsage;              // only on the first step of each API message
  contextTokens?: number;                                  // prompt size for this API call
  error?: { kind: 'tool' | 'api' | 'hook_block' | 'interrupt'; message: RedactedText };
  compaction?: { trigger: 'auto' | 'manual'; preTokens?: number };
  childRunId?: ID;
}

interface TokenUsage { input: number; output: number; cacheRead: number;
                       cacheWrite5m: number; cacheWrite1h: number; thinking?: number }

interface Outcome {
  runId: ID; label: 'success' | 'partial' | 'failure' | 'unknown'; score: number | null;
  source: 'heuristic' | 'manual'; heuristicVersion: string;
  signals: { id: string; fired: boolean | null; weight: number; detail: string }[];
  manual?: { label: Outcome['label']; note?: string; at: ISO };
}
```

### 6.3 Success heuristics v1 (explicit, versioned, shown in the UI)

Score = 0.5 + Σ (weight × fired), clipped to [0, 1]. ≥ 0.65 → success, ≤ 0.35 → failure,
otherwise partial. No signal fired → `unknown`, which is excluded from rates and shown as its own share.

| Signal | Weight | Fires when |
|---|---|---|
| `tests_passed_after_last_edit` | +0.35 | A test command (configurable patterns: vitest, jest, pytest, go test, cargo test, …) ran after the last Edit/Write and returned without error |
| `tests_failing_at_end` | −0.35 | The last test command in the run errored |
| `clean_finish` | +0.10 | The final assistant message ended normally (`end_turn`), with no interrupt |
| `errors_in_tail` | −0.20 | A tool or API error in the last 5 steps was never followed by a success of the same tool |
| `user_retried` | −0.30 | The next human prompt came within 10 min and is a correction (lexicon + similarity ≥ 0.6 to the previous prompt), or the user interrupted |
| `user_moved_on` | +0.10 | The next human prompt is an acknowledgement or a new topic (similarity < 0.3) |
| `shipped` | +0.10 | `git commit` / `git push` / PR creation succeeded in the run |
| `parent_respawned` (subagents) | −0.20 | The parent spawned the same subagent type with a similar prompt again in the same turn |

Manual labels (`garden label <runId> success --note "..."` or the UI button) override heuristics.
Every success rate in the UI shows n, the unknown share, the manual share, a Wilson 95% interval, and
a "how computed" popover listing these signals.

---

## 7. View data contracts (`packages/core/src/views.ts`)

```ts
interface Rate { value: number | null; n: number; nUnknown: number; nManual: number; ci95: [number, number] | null; method: string }

interface GardenView {
  window: { from: ISO; to: ISO };
  beds: { id; name; soil: { model; effort; permissionMode; toolCount; mcpCount; hookCount; instructionBytes }; plantIds: ID[] }[];
  plants: { id; agentId; bedId; name; runs: number; success: Rate; costPerRunUsd: number; totalCostUsd: number;
            lastRunAt: ISO | null; staleDays: number | null; skillIds: ID[] }[];
  skills: { skillId; name; plantId; invocations: number }[];            // care cards
  loops: { loopId; name; tier; targetPlantIds: ID[]; runsPerDay: number;
           state: 'flowing' | 'flooding' | 'dry'; evidence: string[] }[]; // irrigation
  bees: { fromPlantId; toPlantId; calls: number }[];                     // subagent handoffs
  weeds: { id; kind: 'orphan' | 'duplicate' | 'unowned'; subject: { type; id }; bedId?: ID; reason: string }[];
  playbooks: { id; name; steps: { bedId?: ID; plantId?: ID; gate: 'open' | 'closed' | 'unknown'; evidence: string }[] }[];
}
interface BedCompareView { left: BedSnapshot; right: BedSnapshot; harnessDiff: HarnessDiff;
                           sharedAgents: { agentId; left: PlantSummary; right: PlantSummary }[] }
interface PlantView { plant: PlantSummary; agent: Agent; capabilities: { tools; skills; mcpServers; model };
                      runs: RunRow[]; tierBreakdown: Record<LoopTier, number>; otherBeds: PlantSummary[] }
interface ReplayView { run: RunRow; frames: { t: number; stepId; kind; contextFill: number; tokensCum: number;
                       label: string; isError: boolean; forkRunId?: ID; compaction?: boolean }[]; children: ReplayView[] }
interface SeasonsView { familyId: ID; seasons: { harnessVersionId; from; to; provenance; diffSummary: string[] }[];
                        series: { agentId; perSeason: { harnessVersionId; success: Rate; costPerRunUsd; runs }[] }[] }
interface RouterResult { query: string; method: { lexical: 'bm25'; embedding: 'tfidf-lsa' | 'minilm'; weights: Record<string, number> };
                         candidates: { kind: 'agent' | 'skill'; id; plantIds: ID[]; score; confidence: number;
                                       reasons: { kind: 'description_match' | 'similar_past_task' | 'outcome_history'; text: string }[] }[] }
```

---

## 8. Visual encoding spec (the mapping table, made concrete)

Every row exists in the encodings registry, and therefore in the legend.

| Element | Channel | Metric | Scale | Action it prompts |
|---|---|---|---|---|
| Plant | Height | Runs in window | log, 5 steps | "This is load-bearing" vs "nobody calls this" |
| Plant | Bloom (flower count & openness) | Success rate (non-unknown runs) | 0–100%, 5 steps; hollow bud when n < 5 | Trust it / investigate |
| Plant | Droop (stem angle) | Failure share over the last 14 days | > 30% starts drooping | Fix the harness or the prompt |
| Plant | Fade (desaturation, dry tips) | Days since last run | 14 d / 45 d thresholds | Retire or revive |
| Plant | Foliage hue | Median cost per run | Sequential, color-blind-safe, quantized (5 bins) | Move it to a cheaper model |
| Bed soil | Base tone | Model family of the current harness | Categorical, 3–4 tones | Compare harnesses at a glance |
| Bed soil | Texture density | Tools + MCP servers available | Sparse → dense | Too many tools? |
| Bed soil | Strata lines | CLAUDE.md chain size | Bytes, 4 bins | Bloated instructions? |
| Care card | Packet size | Skill invocations by that plant | sqrt | Which skills matter |
| Irrigation | Flow speed and width | Loop runs/day | log | Where loops spend |
| Irrigation | Flooding (overflow, warm tint) | Runaway: rate > 3× baseline, or ≥ N runs with no progress | boolean + evidence | Stop a spinning loop |
| Irrigation | Dry (cracked, no flow) | Expected cadence × 3 elapsed with no run | boolean | Dead loop |
| Bee | Bee count on a path | Subagent calls parent → child | binned | See handoffs |
| Weed | Presence | Orphan / duplicate / unowned item | — | Clean up |
| Playbook | Stepping stones + gates | Gate open/closed from runs | — | Where the playbook breaks |
| Season | Background tint band (Seasons view) | Harness version boundary | categorical | Correlate change with outcome |

Layout rules: beds are allotment plots in a grid. **Each agent occupies the same slot in every bed**, so
the same agent in two beds is in the same place in each and easy to compare. Semantic zoom: at the
far level beds show aggregate bloom, at the middle level individual plants, and at the near level labels and care cards.

---

## 9. Router ("Which one do I call?")

1. Corpus per candidate (agents and skills): name, description, and redacted previews of past task prompts
   it handled (successful ones weighted up).
2. Score = 0.45·BM25 (normalized) + 0.35·cosine(embedding) + 0.20·outcome, where outcome is the
   Beta(2,2)-smoothed success rate on similar past tasks (kNN over past runs).
3. Confidence comes from the top-1 score combined with its margin over the second candidate. I calibrate
   it on the eval set and show it as a percentage with a "how computed" popover.
4. Reasons: matched terms in the description, the 1–3 most similar past tasks with their outcomes, and
   the outcome history with n.
5. In the garden: candidates glow with a confidence badge and everything else dims.
6. Evaluation: about 30 labeled queries over the demo data. I report top-1/top-3 accuracy and an ablation
   (lexical only → + embedding → + outcomes) in PROGRESS.md.

---

## 10. Milestones (each ends with verification and a commit)

| # | Milestone | Contents | Verification gate |
|---|---|---|---|
| M0 | Plan & conventions | PLAN.md, CLAUDE.md, PROGRESS.md, docs/sources.md | Docs present, facts sourced, **your approval** |
| M1 | Contracts & foundations | pnpm workspace, TS/eslint/prettier/vitest, CI workflow; `core` (schema types + zod, view contracts, encodings registry, pricing, heuristic definitions); `ingest` adapter interface, **redaction + proof test**, SQLite migrations + store that only accepts `RedactedText`; docs/schema.md | typecheck, lint, and tests green. Proof test: planted secrets of 15+ kinds across prompts, tool I/O, paths, and settings `env`/`headers` are absent from the raw SQLite bytes |
| M2 | Ingestion + demo data | Claude Code adapter (transcripts with usage dedupe, sidechains/subagents, compaction, errors, harness observation, loop tiers); config scanners (agents, skills, settings/hooks, MCP keys, CLAUDE.md chain); git harness history; outcomes + `garden label`; loop inference; weeds; `garden inspect`; deterministic demo generator (about 6 projects, 90 days, ~2k runs, including the replant scenario) | Golden tests on fixtures (token totals match dedupe math). Demo ingests end to end. This container's real transcript ingests with zero errors. `inspect` reports unknowns without crashing |
| M3 | Server + Garden view | Hono API on 127.0.0.1; `garden export --static`; web shell (routes, legend drawer, how-computed popovers, table toggle); Pixi renderer (beds, soil, plants, care cards, irrigation, bees, weeds, playbook paths, semantic zoom, pan, hover, select) | Build green. Playwright screenshots at 3 zoom levels checked row by row against §8. Test that every registry entry appears in the legend. Bind-address test. No external URLs in the build output. Perf smoke with 500 plants (frame time reported) |
| M4 | Plant + Bed views | Capability card, run table with outcome evidence, manual labeling, tier breakdown, other plantings; Bed compare with harness diff and a **replant** interaction | Label round-trip test (UI → API → DB → recomputed rate shows manual). Screenshot of the demo moment |
| M5 | Time-lapse replay | Replay builder; growth animation (leaf per tool call, brown leaf per error, pruning per compaction, runners for subagent forks, context gauge); scrubber + step panel | Deterministic builder tests. Context-fill values equal the deduped usage math. Screenshots at start/middle/end for a demo run and for this container's real session |
| M6 | Router | `Embedder` interface (TF-IDF+LSA default, MiniLM opt-in), BM25, outcome kNN, confidence, reasons, garden highlight | Eval: top-3 ≥ 80% on the demo query set. Ablation table. Screenshot |
| M7 | Seasons v1 | Season segmentation (git + observed), per-season metrics with Wilson intervals, harness diff summaries, scrub-to-date garden | Segmentation and attribution tests. Numbers cross-checked against direct SQL. Screenshot with a visible before/after |
| M8 | Deliverables & polish | README (one-liner, GIF, ≤ 5-command setup), docs/PRD.md, docs/demo-script.md, docs/schema.md (final), docs/sources.md; fresh-clone check; optional static hosted demo | Script clones into a temp dir, runs the README commands, and confirms the server responds and the garden renders. All tests and the build green |

**Parallel workstreams after M1.** Subagents work in isolated worktrees and code only against the M1 contracts:
A) Claude Code adapter, B) demo generator, C) Pixi renderer against fixture view-contract JSON,
D) router. I integrate, and each workstream must pass its own package tests before merging.

Setup target (README):
```
git clone https://github.com/lamgs/agent-garden && cd agent-garden
pnpm install
pnpm demo                 # → http://127.0.0.1:4310
# your own data:  pnpm garden ingest && pnpm garden serve
```

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Transcript format is undocumented and drifts across versions | Tolerant parser, unknown-field census in `inspect`, version-tagged fixtures, docs/sources.md |
| Claude Code deletes old transcripts (retention setting) | Incremental ingest keeps history in `garden.db`. The README explains how to raise retention |
| Success inference is noisy | Explicit signals, unknown share shown, manual override, heuristic version stamped on every outcome |
| Harness reconstruction gaps (CLAUDE.md not in git, user-level files unversioned) | Provenance label on every harness version, and fingerprints observed from transcript listings |
| Secrets in tool output (`cat .env`, auth headers) | Pattern + entropy redaction, content dropped for sensitive paths (`.env*`, `*.pem`, `id_*`), previews truncated, byte-level proof test |
| Garden turns into decoration | Encodings registry, a legend generated from it, and a screenshot review against §8 at every visual milestone |
| Renderer perf with many textures | Texture cache keyed by genotype bucket, culling, LOD by zoom level |
| Neural embeddings unavailable offline | Lexical-semantic default. The method used is shown in every router result |

## 12. Out of scope (v1)

Multi-user, cloud sync, editing agents from the UI, and non-Claude-Code sources beyond the adapter
interface (an OTel GenAI adapter stub with a contract test is the stretch goal).
