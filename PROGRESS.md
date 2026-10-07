# PROGRESS.md

Status log per milestone. A milestone is marked done only when its verification gate in `PLAN.md` passes.

| Milestone | Status | Evidence |
|---|---|---|
| M0 Plan & conventions | ✅ done (approved 2026-10-07) | PLAN.md, CLAUDE.md, docs/sources.md |
| M1 Contracts & foundations | ✅ done | 75 tests green, typecheck + lint clean; see below |
| M2 Ingestion + demo data | ✅ done | 343 tests green; demo story gate + real-data ingest; see below |
| M3 Server + Garden view | ✅ done | 382 tests + 6 e2e green; screenshots in docs/screenshots/m3-*; see below |
| M4 Plant + Bed views | ⬜ not started | |
| M5 Time-lapse replay | ⬜ not started | |
| M6 Router | ⬜ not started | |
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
