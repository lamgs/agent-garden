# Demo script (about 4 minutes)

Run `pnpm demo` and open http://127.0.0.1:4310 in a window about 1440×900. The dataset is synthetic
and deterministic: 6 projects, 90 days ending 2026-10-01 12:00 UTC (`--as-of`), 2,041 runs, 25
plants. Every number below was read from the running demo on 2026-10-08 (API responses and the
rendered pages). The live stream is a replay of stored runs, so which agents are live at a given
second varies; everything else is fixed.

## 1. The garden, live (45 s)

- "This is my agent system as a garden. Each bed is a project, each plant is an agent working
  there. Height is how many runs, blooms are success rate, droop is the share of recent runs that
  failed, foliage color is median cost per run. Press `L` for the legend: every visual has a row,
  and anything that moves without meaning is labeled 'ambient, no meaning'."
- Point at the live layer: rings around plants (context fill), the ink marks beside them (reading,
  editing, running, delegating), bees flying to subagents. The pill in the header reads
  `Live · demo · N active · M waiting`.
- **Needs you** (top left): agents waiting on you, permission waits first. In the served demo it
  mostly lists main threads whose turn ended (`input · inferred`). Once per replay cycle a `!` row appears (when checked, for `main shop-api`): "possibly waiting for permission: Read tool_use
  without tool_result for 6 s… a slow tool looks the same". Hover a row to show that evidence.
  "Transcripts don't record permission prompts, so this is inferred, and it says so: dashed tag,
  'inferred', and the rule on hover. Nothing here changes my Claude Code settings."

## 2. The same agent, two soils (50 s)

- In **legacy-monolith** (orange edging, `opus 5.5 · xhigh`), the `test-writer` plant bends over.
  Hover it: **26% success, n=102, 95% CI 19–36%**, drooping (87.5% of its last-14-day runs failed).
- In **shop-api** (`sonnet 5.5 · high`) the same agent stands upright: **92%, n=108, CI 85–96%**.
- Click **Compare beds** and pick shop-api and legacy-monolith: main −24 points (separated),
  Explore 0 (within noise), test-writer −65 (separated). Open the test-writer **replant**:
  **92% → 26%, −65 points, separated (intervals don't overlap), cost per run 3.1× ($0.044 →
  $0.135)**. What changed in the soil: sonnet → opus, effort high → xhigh, permissions acceptEdits →
  default, instructions +29.4 KB, +7 MCP servers, hooks and settings changed, one skill fewer.
- Read the caveat aloud: "correlation, not causation: the two sides may have handled different
  tasks."

## 3. Which one do I call? (35 s)

- Press `/` and type `write unit tests for the invoice totals`, then Enter.
- `test-writer` ranks first with **61%** confidence, `main` second with **28%**. In the garden,
  their plants glow and the rest dims. The per-bed badges differ: **88% in shop-api (n=10)** and
  **61% in legacy-monolith (n=10)**: on similar invoice-totals tasks, test-writer went 1 success /
  9 failures in legacy-monolith.
- Open "How computed": lexical 0.45, embedding 0.35, outcome 0.20, and the calibrated confidence
  formula with its holdout Brier score.

## 4. Seasons: did the harness change help? (40 s)

- Click the shop-api bed label, then **Seasons of shop-api →**.
- Two seasons: "Initial commit" and **"Tighten CLAUDE.md and add test hook"** (2026-08-17:
  instructions −10,336 bytes, hooks changed, settings changed, permissions → acceptEdits).
- main goes **51% (n=226, CI 44–57%) → 87% (n=204, CI 81–91%), +36 points, separated**. The
  nightly-flaky-triage loop row, counted separately, goes 89% → 84%, within noise.
- The caveat is at the top of the page: "Correlation, not causation… Read the runs on both sides
  before crediting the harness."
- Drag the scrubber to 2026-08-10 and click **View garden as of 2026-08-10**: the garden rebuilt
  from runs up to that date, with a banner and **Back to now**.

## 5. Knowledge map: what loads every session (35 s)

- Bed picker on legacy-monolith → **Knowledge map**.
- "**~13k tokens** load in every session (budget 10,000), from 19 sources, with 13 findings."
  Project CLAUDE.md alone is ~8.0k tokens (482 lines) and MEMORY.md ~4.6k.
- The red dashed roots: **CLAUDE.md points to `@docs/legacy-runbook.md`, which does not exist**,
  and MEMORY.md points to `billing_quirks_old.md`, which does not exist.
- **MEMORY.md is 260 lines; only the first part is loaded** (Claude Code cuts it at 200 lines /
  25,000 bytes), so the pointers past the cap never reach the model.
- **Orphan memory**: `memory/2024_migration_notes.md` is referenced from nowhere.
- Compare with shop-api: ~0.9k tokens, no dangling references; its budget history shows ~3.0k →
  ~0.4k at "Tighten CLAUDE.md".

## 6. Replay a failing run (35 s)

- Open the legacy-monolith `main` plant → the runs table → **▶ Replay** on the 2026-08-31 13:43 run
  "still broken, same error as before" (`#/replay/run_8308c289de49b5b3`).
- Header: **failure · 6 min 5 s · opus 5.5 · 22 steps · 6 tool calls · 2 subagent runs · 1
  compaction · 841k tokens · $0.367**.
- Press Play at 16×. Two `test-writer` lanes branch off; each ends with **3 red crosses** (errors).
  The dashed cut on the main lane is the compaction, **127k tokens before**; the context gauge
  peaks at **126,794** tokens of the 1M window.
- "This is the run behind one of those droopy leaves: the subagent kept failing, the user said
  'still broken', and the context got compacted along the way."

## Close (10 s)

"All of this ran on my machine from my own Claude Code files: redacted at ingestion, served on
127.0.0.1, nothing sent anywhere. `pnpm garden ingest && pnpm garden serve` does the same for real
data."
