# Agent Garden trace schema (v1)

Source of truth: [`packages/core/src/schema.ts`](../packages/core/src/schema.ts) (types) and
[`packages/ingest/src/store/migrations.ts`](../packages/ingest/src/store/migrations.ts) (SQLite).
View contracts for the UI are in [`packages/core/src/views.ts`](../packages/core/src/views.ts).
A test (`schema-doc.test.ts`) fails if an interface or table is missing from this document.

## Principles

1. **Redacted at the door.** Every free-text field has type `RedactedText`, a branded string only the
   ingestion redactor can create. Adapters emit plain strings, and the pipeline redacts every record
   before it reaches the store. Config maps (`env`, `headers`) are replaced wholesale. Hook commands
   and CLAUDE.md contents are stored only as hashes.
2. **Previews, not transcripts.** Message and tool text is stored as a redacted preview truncated to 2,000
   characters. Truncation happens after redaction, so a secret can't be split and slip through.
3. **Tokens are deduped and dollars are derived.** Claude Code writes one API response as several lines that
   repeat the same `usage`. Tokens are attached once per API message (`Step.tokens`) and summed into
   `Run.tokens`. Cost is computed at read time from `packages/core/src/pricing.ts`.
4. **Honest outcomes.** Every outcome keeps the heuristic version and each signal's result. Manual
   labels live in a separate table, override the heuristic label, and survive re-ingestion.
5. **Stable ids.** Ids are `<prefix>_<16 hex>` hashes of natural keys (path, session id, line uuid), so
   re-ingesting the same files is idempotent.

## Entities

```
Source ─┬─ Session ── Run ──┬── Step ──(childRunId)──▶ Run (subagent)
        │              │    └── Outcome (+ manual label)
HarnessFamily (bed) ───┤
  └─ HarnessVersion (season) ◀── Run.harnessVersionId
Agent ◀── Run.agentId          Skill ◀── Step.tool.skillId
Loop ◀── Run.loopId            Playbook (garden.yaml) → steps → Skill/Agent
```

### Source
One configured input (for example `~/.claude` read by the `claude-code` adapter).
| Field | Type | Notes |
|---|---|---|
| id | ID | |
| adapter | string | `claude-code`, … |
| root | RedactedText | Root path |
| adapterVersion | string | Bumped when the parser changes meaningfully |

### Agent
A model using tools in a reason–act–observe cycle. In Claude Code data that is `main` (the main thread)
or a subagent type.
| Field | Type | Notes |
|---|---|---|
| id | ID | |
| name | string | `main`, `Explore`, `test-writer`, … |
| kind | `main` \| `subagent` | |
| definition? | object | `scope` (user/project/plugin/builtin), `path`, `description`, `tools`, `model`, `contentHash` |
| firstSeenAt / lastSeenAt | ISO | |

### HarnessFamily (bed)
One lineage of harness versions, keyed by project root.
| Field | Type |
|---|---|
| id | ID |
| name | string |
| projectRoot | RedactedText |

### HarnessVersion (season)
A versioned harness bundle. Its id is a hash of the canonical bundle, so identical harnesses share an id.
| Field | Type | Notes |
|---|---|---|
| id | ID | Hash of `bundle` |
| familyId | ID | |
| validFrom / validTo? | ISO | |
| provenance | `git` \| `observed` \| `snapshot` | git = a commit to a harness file; observed = fingerprint change seen in transcripts; snapshot = current files only |
| bundle | HarnessBundle | see below |
| commit? | `{ sha, message: RedactedText }` | |
| diffFromPrevious? | HarnessDiff | model/effort/permission changes, tools/skills/MCP added and removed, hooks changed, instruction byte delta |

**HarnessBundle**: `model?`, `effort?`, `permissionMode?`, `entrypoint?`,
`instructions[] { path, hash, bytes }` (CLAUDE.md chain, content not stored), `tools[]`, `skills[]`,
`subagents[]`, `mcpServers[]` (names only), `hooks[] { event, matcher?, commandHash }`, `settingsHash?`.

### Skill
| Field | Type | Notes |
|---|---|---|
| id | ID | |
| name | string | Canonical: frontmatter `name`, falling back to the directory name |
| dirName | string | May differ from `name` (observed) |
| scope | `user` \| `project` \| `plugin` | |
| path | RedactedText | |
| description? | RedactedText | |
| contentHash | string | |

### Playbook
User-declared in `garden.yaml` for v1.
| Field | Type |
|---|---|
| id, name | ID, string |
| source | `garden.yaml` |
| steps[] | `{ id, skillId?, agentId?, gate: GateSpec }` |

`GateSpec` = `step_success` \| `tests_pass` \| `command_ok { pattern }` \| `manual`.

### Loop
The system that triggers agents, checks their work, and decides what runs next.
| Field | Type | Notes |
|---|---|---|
| id, name | ID, string | |
| tier | LoopTier | `agent` \| `verification` \| `application` \| `hill_climbing` |
| provenance | `declared` \| `config` \| `inferred` | declared = garden.yaml; config = settings hooks; inferred = recurring headless sessions, `/loop`, cron |
| trigger | `{ kind, detail: RedactedText }` | kind: `hook` \| `cron` \| `loop_skill` \| `headless_repeat` \| `stop_continuation` \| `declared` |
| expectedIntervalSec? | number | Used for the dry-loop check |
| targets | `{ agentIds[], familyIds[] }` | |

### Session
One transcript file.
| Field | Type |
|---|---|
| id, sourceId, familyId | ID |
| path | RedactedText |
| cliVersion?, entrypoint?, gitBranch? | string |
| startedAt, endedAt | ISO |

### Run
One agent pursuing one goal. Main thread: one human prompt plus all work until the next human prompt.
Subagent: one invocation.
| Field | Type | Notes |
|---|---|---|
| id, sessionId, agentId, familyId, harnessVersionId | ID | |
| parentRunId?, parentStepId? | ID | Set for subagent runs |
| loopId? | ID | |
| startedAt, endedAt | ISO | |
| trigger | `human` \| `automated` \| `subagent` | |
| taskPreview | RedactedText | First prompt |
| models | string[] | |
| tokens | TokenUsage | Deduped by API message id |
| stepCount, toolCallCount, errorCount, compactionCount | number | |
| peakContextTokens | number | Max prompt size across API calls |

**TokenUsage**: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `thinking?` (subset of output).

### Step
| Field | Type | Notes |
|---|---|---|
| id, runId | ID | |
| seq | number | Order within run |
| at | ISO | |
| kind | StepKind | `user_message`, `assistant_message`, `thinking`, `tool_call`, `tool_result`, `subagent_spawn`, `subagent_return`, `compaction`, `error`, `hook` |
| loopTier | LoopTier | Which of the four nested loops this step belongs to (see below) |
| preview? | RedactedText | Truncated. Thinking keeps only a length marker |
| tool? | object | `name`, `callId`, `category` (builtin/mcp/skill/subagent), `mcpServer?`, `skillId?`, `isError?` |
| apiMessageId? | string | |
| tokens? | TokenUsage | Only on the first step of each API message |
| contextTokens? | number | input + cache read + cache write for that API call |
| error? | `{ kind: tool \| api \| hook_block \| interrupt, message }` | |
| compaction? | `{ trigger: auto \| manual, preTokens? }` | |
| childRunId? | ID | On `subagent_spawn` |

**Loop tier rules (v1)**:
- `verification`: test, lint, and typecheck commands; reviewer subagents; hook executions.
- `application`: `git commit`/`push`, PR creation, deploys.
- `hill_climbing`: edits to CLAUDE.md, `agents/`, `skills/`, `settings*.json`, `.mcp.json`.
- `agent`: everything else.

### Outcome
| Field | Type | Notes |
|---|---|---|
| runId | ID | |
| label | `success` \| `partial` \| `failure` \| `unknown` | Effective label (manual wins) |
| score | number \| null | Heuristic score 0..1 |
| source | `heuristic` \| `manual` | |
| heuristicVersion | string | Currently `h1` |
| signals[] | `{ id, fired: boolean \| null, weight, detail }` | null = not applicable |
| manual? | `{ label, note?, at }` | |

Scoring (`h1`): score = 0.5 + Σ weights of fired signals, clipped to [0, 1]. ≥ 0.65 → success,
≤ 0.35 → failure, otherwise partial. If no signal fired → unknown. Success rate counts success = 1,
partial = 0.5, failure = 0, and excludes unknown.

| Signal | Weight | Applies to |
|---|---|---|
| tests_passed_after_last_edit | +0.35 | all |
| tests_failing_at_end | −0.35 | all |
| clean_finish | +0.10 | all |
| errors_in_tail | −0.20 | all |
| user_retried | −0.30 | main |
| user_moved_on | +0.10 | main |
| shipped | +0.10 | all |
| parent_respawned | −0.20 | subagent |

## SQLite tables

| Table | Holds |
|---|---|
| `meta` | `schema_version` |
| `sources` | Source |
| `agents` | Agent (`definition_json`) |
| `harness_families` | HarnessFamily |
| `harness_versions` | HarnessVersion (`bundle_json`, `commit_json`, `diff_json`) |
| `skills` | Skill |
| `playbooks` | Playbook (`steps_json`) |
| `loops` | Loop (`trigger_kind`, `trigger_detail`, `targets_json`) |
| `sessions` | Session |
| `runs` | Run (token columns `tok_*`) |
| `steps` | Step (flattened tool and error columns, `tokens_json`, `compaction_json`) |
| `outcomes` | Heuristic outcome per run (`signals_json`) |
| `manual_labels` | Human labels. Never touched by ingestion |
| `ingest_files` | Per-file size, mtime, and byte offset for incremental ingestion |

## Adapter contract

Adapters implement `Adapter` (`packages/ingest/src/adapter.ts`):
- `read(ctx)` yields `NormalizedRecord`s (each schema type with `RedactedText` replaced by `string`)
  plus `file_state` markers. It must tolerate unknown shapes: call `ctx.warn`, never throw.
- `inspect()` returns a `Census`: roots, record-type counts, unknown fields, versions. Never content.

The pipeline (`ingest()`) redacts each record, writes in batched transactions, and reports counts,
warnings, and redactions by kind.
