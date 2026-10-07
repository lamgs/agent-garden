# PROGRESS.md

Status log per milestone. A milestone is marked done only when its verification gate in `PLAN.md` passes.

| Milestone | Status | Evidence |
|---|---|---|
| M0 Plan & conventions | ✅ docs written, ⏳ **awaiting approval** | PLAN.md, CLAUDE.md, docs/sources.md |
| M1 Contracts & foundations | ⬜ not started | |
| M2 Ingestion + demo data | ⬜ not started | |
| M3 Server + Garden view | ⬜ not started | |
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
- [ ] User approval of PLAN.md.

Known gaps carried forward:
- Not yet observed on a real file: compaction records and hook-execution records. The parser stays
  tolerant until a fixture exists.
- This container's network policy blocks Hugging Face, so opt-in neural embeddings can't be tested here.
- The user's own data lives on their machine. `garden inspect` (M2) is the first thing to run there.
