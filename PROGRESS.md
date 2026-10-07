# PROGRESS.md

Status log per milestone. A milestone is marked done only when its verification gate in `PLAN.md` passes.

| Milestone | Status | Evidence |
|---|---|---|
| M0 Plan & conventions | ✅ done (approved 2026-10-07) | PLAN.md, CLAUDE.md, docs/sources.md |
| M1 Contracts & foundations | ✅ done | 75 tests green, typecheck + lint clean; see below |
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
