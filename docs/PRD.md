# Agent Garden: product requirements (v1, as built)

Status: v1 complete at M8 (2026-10-08). Scope and milestones: [PLAN.md](../PLAN.md). Status log:
[PROGRESS.md](../PROGRESS.md).

## Problem

People who work with Claude Code end up running a system, not a single assistant: a main thread in
several projects, custom subagents, skills, hooks, scheduled runs, MCP servers, and one CLAUDE.md per
project that grows over time. The data needed to understand that system is already on disk
(transcripts, agent and skill definitions, settings, git history), but nobody reads it. So questions
like these go unanswered:

- Which agents work well, and where? The same agent can do well in one project and badly in another,
  and nothing says so.
- Did the change I made to a harness (a new CLAUDE.md, a hook, a model switch) help?
- For this task, which agent or skill should I call?
- What is loading into every session, and how much of it is stale, duplicated, or broken?
- Which of my running agents needs me right now?

## Users

The primary user runs Claude Code daily across several projects, writes their own subagents and
skills, and changes harnesses often. They are comfortable with a terminal and care about privacy:
their transcripts contain code, credentials in tool output, and client data.

Secondary: someone evaluating a harness change (a team lead comparing projects, a person tuning a
CLAUDE.md) who needs numbers they can trust, with the sample size and uncertainty shown.

## Jobs to be done

1. **See what's thriving, what's wilting, and which one to call.** At a glance: which plantings
   succeed, which fail more often lately, what each costs per run, which loops are flooding or dry,
   and which agent to use for a new task.
2. **Track and verify what was built over time.** See harness versions as seasons, with outcomes
   before and after each change, and replay any single run step by step.
3. **Keep knowledge lean.** Know what each project's agents load in every session, where it comes
   from, and what to cut: over-budget instructions, duplicated passages, dangling imports, orphan
   memory files, a MEMORY.md past its load cap.
4. **Notice what needs me now.** See live which agents are working, what they are doing, and which
   are waiting on a permission or an answer, with the uncertainty of that inference visible.

## Principles

- **The mapping rule.** Every visual property encodes a real metric someone would act on. All
  encodings live in one registry (`packages/core/src/encodings.ts`); the legend is generated from it
  and is one key (`L`) away. Ambient sway is the only meaningless motion, labeled as such, and is off
  under `prefers-reduced-motion`.
- **Honest metrics.** No success rate without its evidence (signals, weights, manual overrides, n).
  Wilson intervals and `n=` on every rate. "Separated" only when intervals do not overlap.
  Comparisons over time and across beds are labeled as correlation. Inferred live states are drawn
  differently from recorded ones and say which rule fired. Cost is derived at read time from tokens.
- **Privacy.** Local only, bound to 127.0.0.1, no telemetry and no remote assets. Redaction at
  ingestion, enforced by a branded type, and proven by a byte-level test over the SQLite files. The
  live layer reads only and changes no settings. Real user data is never committed.

## Scope of v1 (as built)

| View | Answers |
|---|---|
| **Garden** (`#/`) | Which plantings thrive or wilt (blooms = success, droop = recent failures, fade = staleness, foliage = cost), which model each bed runs, which loops are flooding or dry, where the weeds are (orphan agents, unused MCP servers, knowledge bloat). Table view (`T`) has the same numbers. |
| **Live overlay** (on the garden) | Which agents are working now and on what (ring = context fill, mark = activity), errors and compactions this turn, subagent handoffs, and a "Needs you" strip ordered by permission waits first, then longest wait. |
| **Plant** (`#/plant/:id`) | Why this rate: the Wilson interval, how often each heuristic fired, the run table with per-run evidence, manual labels, loop tiers, tools and skills used, the harness it runs under. |
| **Compare / Replant** (`#/compare`, `#/replant`) | How the same agent does in two beds, what differs in the soil (harness diff), and whether the gap is separated or within noise. |
| **Replay** (`#/replay/:runId`) | What happened in one run: a timeline of steps, subagent lanes, errors, compaction, context fill against the window, tokens and cost so far. |
| **Seasons** (`#/seasons/:bedId`) | Did a harness change line up with better outcomes: success per season per agent with intervals, the diff at each boundary, and a scrub-to-date garden. |
| **Knowledge map** (`#/knowledge/:bedId`) | Where the bed's instructions and memory come from, what is always loaded vs on demand, budget over time, and findings with evidence and a suggested action. |
| **Router** ("Which one do I call?") | Ranked agents and skills for a task, with per-bed confidence, reasons (matched words, similar past tasks and their outcomes), and how the score was computed. |
| **CLI** | `inspect`, `ingest`, `label`, `stats`, `serve`, `export`, `db:init`, `live:probe`. |

Data source: Claude Code (verified on CC 2.1.293; see docs/sources.md). A deterministic demo
dataset in real Claude Code formats exercises every view.

## Non-goals (v1)

- Multi-user use, accounts, cloud sync, or a hosted service.
- Editing agents, skills, or settings from the UI. The garden reads; you change things in your editor.
- Installing hooks or changing Claude Code settings to get exact live states.
- A pixel office or character avatars for agents.
- A central playbook or prompt vault.
- Sources other than Claude Code (the adapter interface allows them; none ship).
- Neural embeddings by default (the interface exists; the default is lexical and offline).

## Direction decisions (2026-10-08)

- **Live, but not a pixel office.** Seeing agents work in real time is wanted; office imagery is not.
  The live layer is identity-neutral and draws on the garden itself (rings, marks, bees), and replay
  is an abstract timeline rather than a growing plant.
- **Garden imagery kept.** Beds, plants, soil, and weeds stay as the main view, because each element
  is bound to a metric through the registry.
- **No central playbook vault.** Playbook keeps its v1 meaning: gated skill chains declared in
  `garden.yaml`.
- **Knowledge map instead.** Knowledge efficiency is handled per project: CLAUDE.md, its imports and
  rules, the memory files it maps to, provenance, and bloat checks (milestone K).
- **Time matters more than place.** Tracking what was built over time is the priority. Seasons and
  replay carry it in v1; a fuller time-axis view comes next.

## Open questions

- Is "one human prompt plus everything until the next" the right run boundary for people who chain
  many short prompts? It drives the "user retried" and "user moved on" signals.
- How well do the h1 heuristics agree with manual labels on real data? The demo cannot answer that;
  a labeling pass on real sessions can.
- Should text-only turn ends count as idle rather than "waiting for input"? In the served demo the
  Needs-you strip fills with inferred input waits.
- Pages opened from an as-of garden still show the current window. Should time travel apply to every
  page?
- Is a static hosted demo worth it, given that only the garden view exports today?
- How should an agent whose runs span two harness chains (for example Explore under a subagent's
  harness) be shown in seasons?

## Next candidates

1. **Time-axis view**, mocked up before it is built: runs, harness changes, and knowledge changes on
   one timeline per bed.
2. **Opt-in hooks** for exact live states (permission prompts, idle notifications), installed only
   on request and removable with one command.
3. **Agent teams**: teammates, tasks, and handoffs from Claude Code's team records.
4. **Bed-aware router ranking**: rank plantings, not candidates, and evaluate per bed.
5. **Static export for all pages** (plant, compare, replay, seasons, knowledge), so a demo can be
   hosted without the server.
