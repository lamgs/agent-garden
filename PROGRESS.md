# PROGRESS.md

Status log per milestone. A milestone is marked done only when its verification gate in `PLAN.md` passes.

| Milestone | Status | Evidence |
|---|---|---|
| M0 Plan & conventions | ✅ done (approved 2026-10-07) | PLAN.md, CLAUDE.md, docs/sources.md |
| M1 Contracts & foundations | ✅ done | 75 tests green, typecheck + lint clean; see below |
| M2 Ingestion + demo data | ✅ done | 343 tests green; demo story gate + real-data ingest; see below |
| M3 Server + Garden view | ✅ done | 382 tests + 6 e2e green; screenshots in docs/screenshots/m3-*; see below |
| M4 Plant + Bed views | ✅ done | 407 tests + 10 e2e green; live label round trip; screenshots m4-*; see below |
| M5 Time-lapse replay | ✅ done | 426 tests + 13 e2e green; context fill = raw dedupe (fixture + real data); m5-replay-*; see below |
| M6 Router | ✅ done | 441 tests + 13 e2e green; eval top-3 97% (holdout 100%); m6-router.png; see below |
| L Live layer | ✅ server + client done; garden overlay in progress | 438 tests; line → event p50 20 ms on real data; see below |
| K Knowledge map | 🔄 in progress | |
| M7 Seasons v1 | ⬜ not started | |
| M8 Deliverables & polish | ⬜ not started | |

## M0: Plan & conventions (2026-10-07)

Done:
- Inspected the real Claude Code data available in this cloud container (CC v2.1.293): main
  transcript, subagent transcript + meta file, skills, hook config. Findings are recorded in docs/sources.md.
- Confirmed through the official docs (via a docs-research subagent) the file locations and formats for
  agents, skills, settings/hooks, MCP config, retention, and telemetry. Also recorded in docs/sources.md.
- Checked toolchain and library versions (Node 22.22.0, pnpm 10.28.0, `node:sqlite` works,
  npm latest versions of the planned libraries).
- Wrote PLAN.md (assumptions, schema draft, stack, view contracts, encoding spec, milestones),
  CLAUDE.md (conventions), and this log.

Verification:
- [x] Every format claim in PLAN.md §2 traces to an observation or doc URL in docs/sources.md.
- [x] No application code written (per brief: wait for approval).
- [x] User approval of PLAN.md (approved with defaults).

Known gaps carried forward:
- Not yet observed on a real file: compaction records and hook-execution records. The parser stays
  tolerant until a fixture exists.
- This container's network policy blocks Hugging Face, so opt-in neural embeddings can't be tested here.
- The user's own data lives on their machine. `garden inspect` (M2) is the first thing to run there.

## M1: Contracts & foundations (2026-10-07)

Done:
- pnpm workspace (`packages/core`, `packages/ingest`), TypeScript 6.0.3 strict, ESLint 10 +
  typescript-eslint, Prettier, Vitest 5, and a GitHub Actions CI workflow (typecheck, lint, test).
- `packages/core`: schema types (`schema.ts`), view contracts (`views.ts`), the encodings registry with
  a generated legend (`encodings.ts`, 16 channels covering every row of the mapping table), the
  pricing table (`pricing.ts`), heuristic definitions and scoring (`heuristics.ts`), and Wilson / Beta
  stats (`stats.ts`).
- `packages/ingest`: the `Adapter` interface and `Census` type, the `Redactor` (19 detectors, HMAC-tagged
  markers under a per-install key, config-map replacement, sensitive-path policy,
  truncate-after-redact), a SQLite store on `node:sqlite` with migration v1 that accepts only
  `RedactedText` for free text, the ingestion pipeline (batched transactions), stable ids, and the
  `garden db:init` CLI.
- docs/schema.md, kept in sync by `schema-doc.test.ts`.

Verification:
- [x] `pnpm typecheck`: clean.
- [x] `pnpm lint`: clean. The lint rule bans `as RedactedText` outside `redact/` and `store/` (a probe
  file with the cast fails lint).
- [x] `pnpm test`: 75 passed. Includes:
  - **Redaction proof**: 20 planted secret kinds in every free-text field of all 11 record types,
    including at the truncation boundary. After ingest, no secret and no 12-character fragment of one
    appears in the raw bytes of `garden.db`, `-wal`, or `-shm`, checked both before and after the WAL
    checkpoint. A **negative control** proves the byte scan finds secrets stored without redaction.
  - False-positive guards: code identifiers, function calls and indexing, hashes, UUIDs, `${VAR}`
    references, and placeholders are left intact. Running the detectors over the repo itself found 9
    code false positives (e.g. `tokens: parse(r.tokens_json)`), which are now fixed and covered by
    regression cases. The final repo scan has 0 hits.
  - Store: migration idempotency, round trips, manual label override that survives re-ingestion,
    foreign keys, file state.
  - Encodings: unique ids, every mapping-table element covered, levels in range for extreme inputs,
    bin boundaries.
- [x] `garden db:init` creates the store at schema v1.

Decisions and changes during M1:
- `clean_finish` weight lowered from +0.15 to +0.10. A unit test showed that a clean finish alone hit
  the 0.65 success threshold, so every run that merely ended normally counted as a success. A clean
  finish now needs corroboration (tests passing, or the user moving on). PLAN.md §6.3 is updated.
- TypeScript pinned to 6.0.x: typescript-eslint 8.71 supports `<6.1`.
- Internal entities are plain TS types (zod is reserved for raw-input parsing in M2), so there is no
  zod schema that could brand unredacted text.
- The docs check could not reach the official docs (egress blocked). Findings are recorded with
  confidence tags in docs/sources.md. Compaction record format remains a hypothesis.

Next (M2): Claude Code adapter, config scanners, git harness history, outcome detectors, `inspect`,
and the demo generator, run as parallel workstreams against these contracts.

## M2: Ingestion + demo data (2026-10-07)

How it was built: I wrote the adapter contracts (`adapters/claude-code/contracts.ts`) and stubs
first. Four subagents then worked in parallel git worktrees: (A) transcript parser, (B) config and
git-history scanners, (C) deterministic demo generator, (D) outcome detectors and loop-tier
classifier. Meanwhile I wrote the integration layer: adapter wiring, harness reconstruction, the
store-level derive pass, garden.yaml, and the CLI. All four branches merged without conflicts.

Done:
- `garden inspect` (census of shapes and counts, never content), `garden ingest` (incremental by
  file size/mtime, `--full`), `garden label`, `garden stats`, and `pnpm demo:data`.
- Transcript parser: usage dedupe by `message.id`, subagent files linked through meta `toolUseId`,
  inline sidechains (older format), compaction (hypothesized format), interrupts, API and tool
  errors, MCP/Skill/subagent tool categories, sensitive-path withholding, observed harness state,
  and per-step loop tiers.
- Config scanners: CLAUDE.md chain, agents, skills (canonical frontmatter name), plugin skills, hooks
  (both shapes; commands kept as hashes only), permissions, MCP names from `.mcp.json` and
  `~/.claude.json` (no other keys read), and settings hash with secrets excluded. Git harness history
  rebuilds config as of each commit without a checkout (200 commits ≈ 0.9 s).
- Outcome detectors for all 8 h1 signals, plus a shell-aware test/ship command matcher
  (`echo "pnpm test"` is not a test run).
- Harness versions = config at run time (git) + observed transcript state. The derive pass computes
  validity windows and diffs per (bed, agent), agent seen ranges, and declared + inferred loops.
- Demo generator: 6 projects, 90 days, 701 sessions, 2,041 runs (522 subagent), real CC formats,
  git histories with dated harness changes, generated in ~1 s.

Verification:
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`: 343 tests, 16 files.
- [x] **Demo story gate** (`scripts/demo/src/story.e2e.test.ts`, generate → ingest → derive):
  - test-writer: **0.92 in shop-api vs 0.26 in legacy-monolith** (n≈108 / 102).
  - shop-api main: **0.51 → 0.87** across the "Tighten CLAUDE.md and add test hook" season
    (instructions −9.5 KB, hooks changed).
  - web-dashboard: model switch recorded as a `modelChanged` season.
  - Loops: nightly-flaky-triage owns 90 runs; dependency-update-sweep last ran 2026-08-27 (dry); the
    backfill job with its 40-run runaway burst is inferred as a 129-run loop; 2 hook loops from config.
  - Orphan agent `perf-profiler` present with 0 runs.
  - Redaction: 329 redactions; the generator's planted secrets are absent from the DB bytes.
- [x] **Real data** (this container's own CC 2.1.293 transcripts): `inspect` reports 1,028 lines,
  **0 unknown shapes, 0 warnings**. `ingest` gives 8 runs and 669 steps in 0.3 s. Token totals equal an
  independent dedupe. Main-agent seasons match this repo's real history (pre-harness → M0 commit
  with CLAUDE.md +6,666 bytes, MCP server added, effort xhigh → medium → M1 CLAUDE.md +236 bytes).
- [x] `inspect` reports unknowns without crashing (tested with unknown and malformed lines).

Found on real data and fixed during M2:
- Worktree subagents (`<repo>/.claude/worktrees/<name>`) showed up as separate beds. They now fold
  into the repo (`canonicalProjectRoot`), including after the worktree is deleted.
- Main-thread and subagent harness versions interleaved in one season chain. Chains are now per
  (bed, primary agent).
- **CC 2.1.293 subagent transcripts carry only stream-start usage** (`stop_reason` null, 130–335
  output tokens recorded vs 80–105K visible chars). Runs get `tokenQuality: 'output_estimated'` with
  a lower-bound estimate (schema migration v2). The UI must label costs that include them.
- Hand-written agent frontmatter with an unquoted `: ` inside a value failed strict YAML. It is now read
  as flat `key: value` lines, with a warning.
- A season boundary whose only change was settings showed an empty diff. `HarnessDiff.settingsChanged`
  was added.

Known gaps carried forward:
- Compaction and hook-execution records are parsed from hypothesized/observed shapes only. No real
  compaction has been observed yet.
- Plugin agent definitions are not scanned (plugin skills are).
- `/loop` and `CronCreate` usage inside sessions is not yet turned into loops (only declared loops,
  hooks, and inferred recurring headless runs are).
- The demo data writes real subagent usage, so it doesn't exercise `output_estimated`. Real-data
  tests do.
- Loop health (flowing/flooding/dry) and weeds are view-level computations in M3, over the data
  verified above.

## M3: Server + Garden view (2026-10-07)

How it was built: I wrote the view-model layer, the local server, and the palette (validated with the
dataviz validator, see docs/design.md), and exported a real demo GardenView as a fixture. A
renderer subagent built `apps/web` against that fixture in a worktree. I then merged it, reviewed the
screenshots against PLAN.md §8, and fixed what the review found.

Done:
- `packages/server`: SQL loaders plus a pure `buildGardenView`:
  - Wilson-interval rates (partial = 0.5, unknown excluded, manual counted).
  - Median cost per run with the `costEstimated` / `unpricedRuns` flags.
  - Staleness and recent-failure share.
  - Bees (subagent handoffs).
  - Weeds: orphan or undescribed agents/skills, duplicate descriptions, and MCP servers connected but
    never called (aggregated across beds).
  - Loop health: flowing / flooding (a day ≥ max(4, 3× baseline)) / dry (3× the expected interval).
  - Playbook gates (step_success, tests_pass, command_ok, manual).
- Hono app on **127.0.0.1 only** with a strict CSP (no remote origins, no eval). `/api/garden`,
  `/api/legend`, `/api/health`, and SPA static serving.
- `garden serve` (with `--as-of` for the demo) and `garden export` (static site; marks index.html so
  the app reads `data/` without probing `/api`). `pnpm demo` is one command: build + data + serve.
- `apps/web` (React 19 + Vite 8 + PixiJS 8 imperative renderer):
  - Procedural ink-line plants cached by genotype (the tuple of encoding levels).
  - Allotment beds with edging color + direct label, soil texture, and strata.
  - Seed packets, irrigation channels, bees, weeds, playbook stepping stones with gates.
  - Semantic zoom (far/mid/near), pan, keyboard focus, hover tooltips with "How computed", plant side panel.
  - Legend drawer generated from the registry, with swatches drawn by the garden's own code.
  - Table view, reduced-motion support.

Verification:
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`: 382 tests, all green.
- [x] `pnpm e2e`: 6 Playwright tests against the built app served with the production CSP: no console
  errors, no CSP violations, no request to any host but 127.0.0.1; legend lists every registry
  entry; reduced motion freezes ambient animation.
- [x] Screenshots checked by me against §8: `docs/screenshots/m3-garden-{far,mid,near}.png`,
  `m3-legend.png`, `m3-table.png`, `m3-tooltip.png`, `m3-live-api.png`, `m3-synthetic500.png`.

| §8 row | Where visible | Result |
|---|---|---|
| Plant height = runs | mid/near (main tall, release-manager a seedling); legend | ✅ |
| Bloom = success (hollow bud n<5) | flowers at mid/near; far view pools per bed (legacy-monolith 2 blooms, 43%) | ✅ |
| Droop = 14-day failure share | legacy-monolith test-writer bends over; tooltip "Drooping (≥50%)" | ✅ |
| Fade = days since last run | straw foliage + brown tips on stale plants | ✅ |
| Foliage = median cost/run | validated green ramp; hatched when unpriced; "estimated" in tooltip/table | ✅ |
| Bed edging + label = model family | `legacy-monolith · opus 5.5 · xhigh` at every zoom | ✅ |
| Soil texture / strata = tools / CLAUDE.md size | speck density; strata on bed face (legacy has 3) | ✅ (strata subtle) |
| Care cards = skill invocations | seed packets at near, max 3 + "+n" | ✅ |
| Irrigation flow / state | solid animated water for recorded loops; flooding puddle + ⚠ label; dry cracked ditch + label | ✅ |
| Irrigation observed (new) | configured hooks drawn thin and dotted; no rate claimed | ✅ |
| Bees = subagent calls | 1–3 bees on arcs parent → child | ✅ |
| Weeds | legacy bed corner + compost corner; reasons on hover | ✅ |
| Playbook gates | shop-api: changelog ✓, tests ×, tag ? (not reached) | ✅ |
| Season band | Seasons view (M7) | n/a in M3 |
| Ambient sway | legend: "ambient, no meaning"; off under reduced motion | ✅ |
- [x] Encodings registry ↔ legend: unit test plus e2e count, both derived from the registry.
- [x] Bind address: test asserts `server.address()` is 127.0.0.1. Live check: `garden serve` sends the CSP header.
- [x] No external URLs: `build-output.test.ts` scans `dist` (allowlist of inert namespace/doc strings).
  A negative control with a planted CDN URL fails it. CI now builds before testing.
- [x] Live end-to-end in Chromium against `garden serve` (demo store): 25 plants, "live API · 90 days",
  0 console errors, 0 remote page requests. Static export served from a plain file server: 25 plants,
  0 errors, no `/api` probe, 0 remote requests.
- [x] Perf smoke (500 synthetic plants, headless SwiftShader, 1440×900): our CPU work ≈ 8 ms/frame
  avg (p95 18 ms); frames ≈ 90 ms apart, bound by the software GPU (a blank page runs at 60 fps).
  296 cached textures. A smoke check, not a gate; a real GPU is needed for true numbers.

Found in review and fixed:
- Configured hooks drew the widest channels from an upper-bound proxy rate, so they dominated the
  view while the real flooding loop looked minor. Added `LoopChannel.observed` and the
  `irrigation.observed` encoding: unrecorded loops claim no rate and are drawn thin and dotted. The
  proxy appears only in the evidence text.
- Global fixed slots for ~14 agents left beds mostly empty soil. Agents planted in ≥ 2 beds keep a
  fixed slot (cross-bed comparison preserved, test enforced); bed-only agents pack after them.
  **This narrows PLAN §8's "each agent in the same slot in every bed" to shared agents**, which
  are the only ones a cross-bed comparison applies to.
- The builder's dry-loop check used the array's last run instead of the latest one.
- Static exports logged a 404 probing `/api`. Exports now mark their index.html.

Known gaps:
- Beds are still roomy where a bed lacks several shared agents. Plants are small at "fit" on a laptop.
- At mid zoom, playbook gates and the compost corner are small (fine at near).
- Hover needs a pointer move to trigger (a Pixi pointer-events detail).
- In this container the Chromium binary itself attempts Google background connections (blocked by the
  proxy) even with background networking disabled. Page-level requests are 0, which is what the
  app controls and what the e2e test asserts.
- Real-GPU performance is unmeasured here.

## M4: Plant + Bed views (2026-10-08)

How it was built: I defined the contracts (`PlantView`, `HarnessSummary`, `SignalStat`, `RunRow`,
`BedCompareView`, `RateDelta`, `ReplantView`, `LabelRequest`), wrote the server builders, routes,
label write path and security guards, and exported real demo responses as fixtures. A UI subagent
built the pages against them in a worktree. I merged it, ran a live label round trip myself, and
reviewed the screenshots.

Done:
- **Plant view** (`#/plant/:id`), a "specimen page":
  - The plant drawn large by the garden's own genotype code, with key numbers and their encoding levels.
  - A capability card (definition, allowed tools) and the harness it runs under (model, effort,
    permissions, instructions size, MCP/skills/hooks, provenance, changes).
  - "Why this rate": Wilson interval, n, unknown and manual counts, method text, an outcome-mix bar,
    and a table of how often each heuristic fired.
  - Loop-tier breakdown, tools/skills/MCP actually used, and a runs table with expandable per-signal
    evidence and labeling controls.
- **Bed compare** (`#/compare`): two beds with their plants, "what differs in the soil" (harness
  diff), and shared agents with success delta, a **separated / within noise** badge (Wilson
  intervals overlap or not), cost ratio, and the correlation caveat.
- **Replant** (`#/replant`), the demo moment: the same agent drawn in both soils, the delta, cost
  ratio, soil changes, a per-signal comparison, recent tasks on each side, and the caveat. A bed
  where the agent never ran is shown as empty soil with the harness difference and no prediction.
- **Manual labels**: `POST /api/runs/:id/label` (zod-validated). Notes are redacted by the ingestion
  `Redactor` before storage. Fixture and static modes show the controls disabled with the reason.
- **Local-only guards** (docs/api.md): requests addressed to any non-loopback `Host` get a 403
  (DNS-rebinding defence). Writes need a loopback `Origin` and `application/json` (CSRF defence).

Verification:
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`: 407 tests. `pnpm e2e`: 10 Playwright tests.
- [x] **Label round trip, API level** (server tests): a label flips the run in the plant view, `nManual`
  increments in both the plant and garden views, the heuristic label stays visible, the note is stored,
  and clearing restores the exact previous rate. A planted secret in a note is redacted. Bad
  input → 400, unknown run → 404, a note without a redactor → 501.
- [x] **Label round trip, live UI → API → DB** (Chromium against `garden serve`, copy of the demo store):
  before 26% / 0 manual / 0 DB rows → click Success with a note → DB row `success` + note, view
  27% / 1 manual (`docs/screenshots/m4-label-live.png`) → Clear → 26% / 0 / 0 rows. 0 console errors.
- [x] **Guards**: foreign Host → 403; POST without Origin, with a foreign or `null` Origin → 403;
  `text/plain` → 415; the run stays heuristic.
- [x] **Demo moment** (`docs/screenshots/m4-replant.png`): test-writer upright and blooming in
  shop-api (92%, CI 85–96%, n=108, $0.044/run) vs drooping with one flower in legacy-monolith (26%,
  CI 19–36%, n=102, $0.135/run). **−65 points, separated, 3.1×**. Soil changes: sonnet → opus,
  +29.4 KB instructions, +7 MCP servers, hooks changed, effort high → xhigh.
- [x] Screenshots reviewed: `m4-plant.png`, `m4-plant-runs.png`, `m4-compare.png` (main −24
  separated; Explore 0, within noise; test-writer −65 separated), `m4-replant.png`,
  `m4-label-disabled.png`, `m4-label-live.png`.

Found and fixed during M4:
- Replanting into a bed where the agent never ran compared the subagent's observed harness with the
  bed's main-thread harness ("tools +12"). Both sides now use the beds' current harnesses in that case.

Known gaps:
- The plant, compare, and replant views need `garden serve`. The static export only contains the garden.
- The Pixi garden keeps ticking (hidden) under pages: instant return, some idle CPU.
- Signal names and tier descriptions are duplicated in the web app rather than served.
- ~~`pnpm demo:data` run inside a git worktree collapsed projects into one bed.~~ Fixed 2026-10-08:
  `canonicalProjectRoot` asks git first and folds by path shape only for deleted worktrees.

## M5: Time-lapse replay (2026-10-08)

Direction change during the build: the user asked for visuals more abstract than flowers and
centered on time, so the replay stage is a **timeline**, not a growing plant (PLAN §10 M5's
leaf/pruning/runner wording is superseded for this view).

Done:
- `packages/server/src/replay.ts`: `loadReplayInput` (SQL: run, steps, skill names, subagent runs
  via `subagent_spawn → childRunId`, depth ≤ 3, cycle-safe) and a pure `buildReplay`. Context =
  latest prompt size per API message, deduped by `apiMessageId`, carried forward; zero-size reports
  (synthetic API errors) don't move it. `tokensCum` deduped per message; `costUsdCum` priced at query
  time. Context window from `resolveModelPrice(model).contextWindow`, with a source sentence
  (pricing-table version, garden.yaml override, unknown-model fallback 200K, "exceeds the window").
  Labels come only from redacted previews; thinking shows only its length (`Thinking (1.2k chars)` /
  `no text recorded`). Results are named by their call (`Edit …/src/app.ts → ok`).
  `buildReplayView(store, runId, pricing)` composes both. `GET /api/replay/:runId` (404 unknown).
- Contract: one optional field, `ReplayFrame.costUsdCum` (the step panel needs cumulative cost and
  the frame only had tokens; estimating cost from a token share would be dishonest).
- Web `#/replay/:runId` and `#/replay?plant=<id>` (latest run). Reached from a "▶ Replay" button on
  every plant-view run row and "Replay its latest run →" in the garden's plant panel.
  - Stage (`ReplayStage`, props: the ReplayView + current index): one lane per run, subagent lanes
    branch at the spawn and merge back at the child's end; x = time with gaps > 15 s drawn 4 s wide
    and labeled; mark shape = step kind (row above/below the lane line for calls/results), color =
    tool category, red cross = error, dashed cut = compaction; context band under the main lane
    against the dashed window line (50%/80% guides); faded marks = not yet reached; playhead.
    Lanes collapse to span + errors (auto-expanded when ≤ 4 children). Click a mark to seek.
  - Scrubber over compressed time, play/pause, 1×/4×/16×, ←/→/Home/End/Space, real UTC timestamps.
  - Step panel (label, kind, tool + category/server/skill, tier, error, tokens and cost so far with
    how-computed tips) and context gauge (fill vs window, 50/80% ticks, peak, compactions, source).
  - Playback order walks every step of every lane in time order, so subagent steps play too.
  - 8 registry entries (`replay.*`) with swatches drawn by `garden/replay-draw.ts`.
- Fixture `apps/web/src/fixtures/replay.demo.json` (2 runs) exported by
  `packages/server/src/replay-fixture.ts` from demo data generated **outside the git worktree**
  (worktree generation collapses beds); run ids match the M4 fixtures.

Verification:
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`: 426 tests (27 files).
- [x] Builder tests: byte-identical output on rebuild; fixture context values equal an independent
  first-usage-per-`message.id` walk of the raw JSONL (compaction fixture, repeated-usage lines,
  subagent file); final `tokensCum` = run total; final `costUsdCum` = run cost; pure-builder tests
  for duplicate message ids, window overflow, unknown models, dangling forks, labels.
- [x] Real data (this container, skipped when `~/.claude/projects` is absent): a snapshot copy is
  ingested and every run's per-step context and final tokens equal the independent raw dedupe.
- [x] `pnpm e2e` incl. `m5.spec.ts`: garden panel → replay; plant runs table → replay; start/mid/end
  screenshots, playback at 16×, lane collapse, legend lists replay channels, unknown-run state.
  Screenshots: `docs/screenshots/m5-replay-{start,mid,end}.png` (demo, legacy-monolith main run with
  two test-writer subagents, 6 red crosses, one compaction) and `m5-replay-real.png` (this
  container's orchestrating session, 7 subagent lanes; served through a mocked API from a JSON
  built locally). The real-session screenshot is gitignored (`*-real.png`): it shows redacted but
  real prompt text, so it stays local per the never-commit-real-data rule.

Known gaps:
- The context band is linear against a 1M window, so typical runs fill only a thin strip (honest,
  but low-contrast). The gauge gives the number.
- Merge-back is drawn at the child's end time, not at the parent's matching tool_result.
- Real-session screenshot needs `GARDEN_REAL_REPLAY=<json>`; otherwise that e2e test is skipped.
- Error labels quote the redacted error text, which can include absolute paths from the data.

## Live layer: transcript tailer, live state machine, SSE API, demo live source

Status: built (backend only; the pixel-art renderer consumes `/api/live/stream`). No view changed, so
no screenshot.

- [x] `packages/ingest/src/live/`: `LiveTailer` (fs.watch recursive + 250 ms poll, per-file offsets,
  partial-line buffer, truncation/rotation, 30-min start window seeded from 256 KB tails, subagent
  files linked by `.meta.json` `toolUseId` with retry, optional session registry), pure
  `reduceLive` / `tickLive` (tested with an injected clock), `LiveHub`, `DemoLiveSource`.
- [x] Server: `GET /api/live`, `GET /api/live/stream` (snapshot, then event/agent/gone, 15 s heartbeat,
  unsubscribe on disconnect). `garden serve` live on by default, `--no-live`, `--live-demo`;
  `pnpm demo` uses `--live-demo`. `garden live:probe` for verification.
- [x] Privacy: planted secrets written into a tailed transcript are absent from every emitted message,
  the snapshot, and the SSE bytes; thinking text never emitted; previews ≤ 120 chars; nothing written.
- [x] Real data (this container): events within p50 20 ms / max 92 ms of the line timestamp with
  fs.watch, p50 190 ms / max 279 ms polling only. One unknown shape (`attachment.type=instructions`).
  Live `bedId` / `plantId` join the stored history (checked against the store).
- [x] Demo replay over a 6-bed demo store: first minute showed all six beds, subagent forks, an error,
  a compaction, and a waiting_permission moment.

Known gaps:
- Permission waits are inferred (timer, registry `waiting`); no real permission prompt could be
  produced here (auto-approve), so the registry `waitingFor` path is untested on real data.
- `loop` on LiveAgent is never set; `LiveAgent.plantId` only for plantings already in the store.
- Inline sidechain lines (older CC format) become child agents but are not linked to a spawn call.
- Demo: one stalled call per cycle; `turn_end` is synthesized at the end of each replayed run.
- `pnpm demo:data` run *inside a git worktree* collapses projects into one bed (paths resolve to the
  worktree root). From the main checkout it's correct.

## M6: Router, "Which one do I call?" (2026-10-08)

Built in a worktree against the M5–M7 contracts (`RouterCandidate`, `RouterResult`; `views.ts` unchanged).

Done:
- **`packages/router`** (`@garden/router`, depends only on `@garden/core`): pure and offline.
  - Corpus per candidate (every agent and skill): name, description, and the redacted task previews
    of its past runs. Previews with fewer than 3 content tokens ("thanks, commit it") are follow-ups
    and are skipped. A run counts for its agent and for every skill it invoked. Per-run weight:
    success 1, partial 0.7, unknown 0.6, failure 0.35. Repeated tasks are damped by 1 + ln(count).
  - **Lexical**: BM25 (k1 1.2, b 0.75, Lucene idf) over one weighted document per candidate,
    divided by the best score for the query.
  - **Embedding**: an `Embedder` interface. The default is TF-IDF (sublinear tf, smoothed idf, l2)
    plus LSA: a rank-64 truncated SVD in TypeScript (seeded block subspace iteration, then
    Rayleigh–Ritz with a Jacobi eigensolver). Deterministic, with no network and no model download.
    The component is the mean of two cosines: query vs name + description, and query vs the
    candidate's 3 most similar past tasks. `createMiniLmEmbedder()` is an opt-in stub that throws
    `EmbedderUnavailableError` ("not available offline").
  - **Outcome kNN**: Beta(2,2)-smoothed success over the candidate's k = 10 most similar past runs
    with cosine ≥ 0.3. Unknown labels are excluded. With no similar runs it is the prior, 0.5.
  - **Score** = 0.45·lexical + 0.35·embedding + 0.20·outcome. A candidate with no lexical or
    embedding signal is never suggested, so gibberish gets an empty list.
  - **Confidence** = σ(a + b·score + c·margin), where margin = score − the best *other* candidate's
    score (positive only for #1). Fitted by Platt/logistic regression (L2 0.1, Newton) on the
    calibration split, top-5 candidates per query (n = 105). Recorded in `calibration.ts`:
    a −2.9807, b 4.2622, c 7.6643. The text goes into `method.calibration`.
  - **Reasons**: the matched name/description words, the 1–3 most similar past tasks with their
    outcome counts and similarity, and the outcome history (kNN counts → smoothed %, n, plus the
    all-runs rate with n).
- **Eval**: 31 hand-written queries (`eval-queries.ts`) covering every agent and skill that has a
  description or past runs, the main thread, and the loop tasks. A test checks that no query equals
  or contains a demo task preview. Every third query is held out of calibration. One query
  accepts two answers: the changelog-writer / release-notes duplicate skills.
  `pnpm router:eval [--db <garden.db>] [--verbose] [--fit] [--export <file>]` prints the table.
  The gate test is `packages/server/src/route.eval.test.ts`. It generates the demo in a tmpdir
  outside any worktree.
- **Server**: `GET /api/route?q=&days=&limit=`. zod validates it: q is trimmed, 1..500 chars,
  limit 1..20. The window's index is cached per `days|asOf` (LRU of 4, about 0.35 s to build on
  the demo, about 1–6 ms per query) and cleared when a manual label is written.
- **Web**: a "Which one do I call?" box in the header above the window controls. `/` focuses it
  and `Esc` clears it. Results show rank, kind, a confidence badge and meter, the beds the
  candidate is planted in, "open plant", the reasons, and a "How computed" breakdown (each
  component × weight = what it adds, the score, the confidence formula and calibration text, n and
  corpus size). In the garden, the candidates' plants glow with a confidence badge and everything
  else dims, through `GardenRenderer.highlight(plantIds, badges)` plus `garden/highlight.ts`.
  This is a new registry channel, `router.highlight` (element `router`, 2 levels), with a legend
  swatch drawn by the same pen code. Fixture mode bundles 5 real RouterResults exported from the
  demo store (`apps/web/src/fixtures/router.demo.json`, plant ids match `garden.demo.json`). Any
  other question shows those 5 as clickable examples.

Eval (demo seed 42, 90-day window ending 2026-10-01T12:00Z; 19 candidates, 1,639 runs, 623 unique tasks):

| Router | top-1 (all) | top-3 (all) | top-1 (calib.) | top-3 (calib.) | top-1 (holdout) | top-3 (holdout) |
|---|---|---|---|---|---|---|
| lexical (BM25) only | 97% | 97% | 95% | 95% | 100% | 100% |
| + embedding (TF-IDF+LSA) | 90% | 97% | 95% | 95% | 80% | 100% |
| + outcome kNN (full) | 90% | 97% | 90% | 95% | 90% | 100% |

n = 31 (21 calibration, 10 holdout). Calibration: Brier 0.041 on the calibration split, **0.043 on
the holdout** (always predicting the base rate scores 0.16). Holdout top-1 mean confidence is 74%
against 90% observed accuracy (n = 10), so it is slightly under-confident at this n.

Reading the ablation honestly: on this query set, **BM25 alone is best at top-1**. Embedding and
outcomes leave top-3 unchanged and cost two top-1 hits: "locate the session handling…" goes to
main over Explore, and "backstory behind the scheduler…" goes to main over legacy-archaeologist.
The main thread has hundreds of similar-sounding past tasks. The demo's descriptions and task
templates share vocabulary with natural queries, so lexical matching is strong. The 0.45/0.35/0.20
weights are the plan's and were not tuned on the eval, to avoid overfitting 31 queries. The one top-3 miss,
"document how the date range picker behaves", ranks docs-writer 4th behind main.

Verification:
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm build`. `pnpm test`: 441 tests (34 new). `pnpm e2e`: 13 (3 new).
- [x] Eval gate: top-3 ≥ 80% overall (97%) and on the holdout (100%). The recorded calibration
  coefficients must match a refit (2 decimals), and the recorded holdout Brier must match.
- [x] `/api/route`: plant ids are plants in the garden view; 400 on missing/blank/501-char q,
  bad limit or days; a cached second query under 150 ms; gibberish gives no candidates.
- [x] Screenshot `docs/screenshots/m6-router.png`, reviewed. For "write unit tests for the invoice
  totals": test-writer 61% (glowing in shop-api and legacy-monolith), main 28% (six plants), all
  other plants and beds dimmed. The reasons surface the demo story: on similar invoice-totals
  tasks test-writer went 1 success / 9 failure → 21% outcome (n = 10).

Follow-up (same day): **per-bed badges.** The outcome component is now also computed per planting
(only that bed's similar runs), and each plant's badge and the results list show it. For "write unit
tests for the invoice totals", test-writer reads 88% in shop-api (n=10) and 61% in legacy-monolith
(n=10); before, both plants showed 61%. Unit test: two beds with opposite histories get opposite
per-bed outcomes. The eval still ranks candidates (not plantings); its numbers are unchanged.

Known gaps:
- ~~Not bed-aware: one confidence per agent across beds.~~ Fixed by per-bed badges (above). The
  top-level confidence and the eval still rank candidates, not plantings.
- The eval is small (31 queries, 10 held out) and written by the person who built the router.
  Treat the confidence as indicative.
- Built-in agents (Explore, Plan, general-purpose) have no description in the data, so they are
  found only through their past tasks.
- MiniLM is an interface only: no weights ship, and nothing downloads.
- Fixture mode answers only the 5 bundled questions. Static exports have no router.
- The router box adds about 18 px to the header, so earlier m3/m4 screenshots (not regenerated in
  this commit) are slightly out of date.

## Live UI: garden overlay, Needs-you strip, event ticker (2026-10-08)

Status: built. Verified in fixture mode (`?fixture=demo`) and against a served demo store
(`garden serve --live-demo`, dataset generated outside the worktree).

Mapping. Every channel is registered in `encodings.ts` (`element: 'live'`), with swatches drawn by
`garden/live-draw.ts`:

| Element | Channel | Metric |
|---|---|---|
| Ring on the soil around the plant (`live.ring`) | Arc length and context-bin color (replay bins); faint when idle or done | A live run; prompt size ÷ context window |
| Ink mark in a tag right of the plant top (`live.activity`) | 11 marks: thinking, reading, searching, editing, running, web, MCP, skill, delegating, compacting, done | Current activity (the panel shows the rule that decided it) |
| Amber `!` / `?` tag (`live.attention`) | Solid = recorded (hooks, session registry, AskUserQuestion); dashed = inferred | Waiting for permission / input |
| Red ticks on the ring (`live.error`) | 1–3 ticks, bold while the newest event is the error | Errors this turn |
| Cut across the ring (`live.compaction`) | Shown for 3 s; the ring restarts | A compaction just happened |
| Live bee (`live.bee`) | Flies parent → child, hovers while the child is live, flies back | A subagent handoff happening now (same meaning as bee paths) |
| Channel pulse (`live.loop_pulse`) | One bright pulse (a static 2 s glow with reduced motion) | A loop just started a run |
| Seedling with a "new" flag (`live.seedling`) | Sits in a free slot of its bed | A live agent with no planting yet |
| Pips beside the tag (`live.count`) | 0–3 pips | Live runs sharing one plant (the ring and tag show the most urgent) |

- [x] Overlay: `garden/live-overlay.ts`, its own Pixi layer attached with `GardenRenderer.addOverlay`
  (scene, camera, and ticker hooks; the router highlight does not dim it). The pure model lives in
  `live/overlay-model.ts`: join by plantId, then bed + agent name, then seedling, then off-stage;
  urgency grouping; bees; loop pulses; compaction cuts. Seedling slots come from
  `garden/live-layout.ts`. The store (`live/live-store.ts`) feeds the overlay directly; React only
  renders the chrome.
- [x] Chrome:
  - Live pill. States: live / fixture / connecting / reconnecting / off. Shows the source and how many
    agents are active and waiting. Click toggles the layer; `?live=off` starts with it off.
  - Needs-you strip. Permission waits first, then the longest wait. Each row has an inferred label and
    its evidence on hover; click opens the plant. Top 5 rows, then "+N more".
  - Event ticker, collapsible.
  - Plant panel "Now" section: activity and how it was decided, tool, context fill, tool calls and
    errors this turn, loop, model, and a link to the latest stored replay.
- [x] The live stream opens only on the garden view, and only where it can exist. `/api/health` now
  reports `live`. Static exports and non-demo fixtures request nothing. When the stream is
  unavailable the layer is off: the client's demo fallback is never mixed into a real garden.
- [x] Fixture stream: the shop-api publish waits 26 s (was 16 s). infra now also delegates to a new
  `cost-estimator` agent, which has no planting and so shows the seedling.
- [x] Tests:
  - `overlay-model.test.ts`: join, glyph mapping, urgency, the inferred rule, bees, pulses, seedling slots.
  - The legend test covers the 9 new channels.
  - `e2e/live.spec.ts`: overlay; the inferred permission wait in Needs you, with evidence; the ticker
    advances; panel "Now"; legend; pill toggle; no console errors or external requests; with reduced
    motion, bees are placed and never fly; `?live=off`.
- Screenshots: `docs/screenshots/live-garden.png`, `live-needs-you.png`, `live-panel.png`, and
  `live-served.png` (served demo store). The reduced-motion garden test now runs with `live=off`:
  live state changes are not motion, but they change pixels. Older milestone screenshots were not
  regenerated in this commit.

Known gaps:
- Served mode never sets `LiveAgent.loop`, so the loop pulse only appears in fixture mode so far.
- The served demo keeps ended main sessions as `waiting_input` for the whole active window, so Needs
  you fills with inferred input waits (capped at 5 rows). The research suggests treating text-only
  turn ends as idle.
- Seedlings and off-stage agents are not clickable: there is no planting to open. Off-stage agents
  (bed not in the window) appear only in the strip and the ticker. The far zoom hides the overlay.
- `LiveAgent` has no run id, so "Now" links to the latest stored replay, not to the run in progress.
- Server previews for some tools are raw JSON input (e.g. `{"command":"pnpm test…`). They are
  redacted, but not pretty.
