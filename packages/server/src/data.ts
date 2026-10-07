/**
 * Loads the rows a view needs from the store. All builders downstream are pure functions over
 * these rows, so they can be unit-tested without SQLite.
 */
import type { HarnessBundle, OutcomeLabel, OutcomeSignalResult, PlaybookStepRow } from './types';
import type { Store } from '@garden/ingest';

export interface RunRow {
  id: string;
  agentId: string;
  familyId: string;
  harnessVersionId: string;
  parentRunId: string | null;
  loopId: string | null;
  startedAt: string;
  endedAt: string;
  trigger: string;
  models: string[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  };
  tokenQuality: 'reported' | 'output_estimated';
  /** Effective label: manual wins. */
  label: OutcomeLabel;
  manual: boolean;
  signals: OutcomeSignalResult[];
  taskPreview: string;
  errorCount: number;
}

export interface GardenData {
  families: { id: string; name: string }[];
  versions: {
    id: string;
    familyId: string;
    validFrom: string;
    validTo: string | null;
    bundle: HarnessBundle;
    primaryAgentId: string | null;
  }[];
  agents: {
    id: string;
    name: string;
    kind: 'main' | 'subagent';
    definition: { scope: string; description?: string } | null;
  }[];
  skills: { id: string; name: string; description: string | null; scope: string }[];
  runs: RunRow[];
  skillCalls: { runId: string; skillId: string; seq: number }[];
  mcpCalls: { familyId: string; server: string; n: number }[];
  loops: {
    id: string;
    name: string;
    tier: string;
    provenance: string;
    triggerKind: string;
    triggerDetail: string;
    expectedIntervalSec: number | null;
    targets: { agentIds: string[]; familyIds: string[] };
  }[];
  playbooks: { id: string; name: string; steps: PlaybookStepRow[] }[];
  /** Per playbook: the most recent run in the window that started it (invoked its first step). */
  attempts: Record<string, { runId: string; steps: AttemptStep[] }>;
}

/** The parts of a stored step needed to evaluate playbook gates. */
export interface AttemptStep {
  seq: number;
  kind: string;
  preview: string | null;
  toolName: string | null;
  callId: string | null;
  skillId: string | null;
  isError: boolean;
  errorKind: string | null;
}

const json = <T>(v: unknown, fallback: T): T =>
  typeof v === 'string' ? (JSON.parse(v) as T) : fallback;

export function loadGardenData(store: Store, from: string, to: string): GardenData {
  const db = store.db;
  const all = <T>(sql: string, ...p: string[]) => db.prepare(sql).all(...p) as T[];

  const runs = all<Record<string, unknown>>(
    `SELECT r.*, COALESCE(m.label, o.label, 'unknown') AS eff_label, m.run_id IS NOT NULL AS is_manual, o.signals_json
       FROM runs r LEFT JOIN outcomes o ON o.run_id = r.id LEFT JOIN manual_labels m ON m.run_id = r.id
      WHERE r.started_at >= ? AND r.started_at <= ? ORDER BY r.started_at`,
    from,
    to,
  ).map((r): RunRow => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    familyId: String(r.family_id),
    harnessVersionId: String(r.harness_version_id),
    parentRunId: r.parent_run_id === null ? null : String(r.parent_run_id),
    loopId: r.loop_id === null ? null : String(r.loop_id),
    startedAt: String(r.started_at),
    endedAt: String(r.ended_at),
    trigger: String(r.trigger),
    models: json<string[]>(r.models_json, []),
    tokens: {
      input: Number(r.tok_input),
      output: Number(r.tok_output),
      cacheRead: Number(r.tok_cache_read),
      cacheWrite5m: Number(r.tok_cache_write_5m),
      cacheWrite1h: Number(r.tok_cache_write_1h),
    },
    tokenQuality: r.token_quality as RunRow['tokenQuality'],
    label: r.eff_label as OutcomeLabel,
    manual: Boolean(r.is_manual),
    signals: json<OutcomeSignalResult[]>(r.signals_json, []),
    taskPreview: String(r.task_preview),
    errorCount: Number(r.error_count),
  }));

  const playbooks = all<Record<string, unknown>>('SELECT * FROM playbooks ORDER BY name').map(
    (p) => ({
      id: String(p.id),
      name: String(p.name),
      steps: json<PlaybookStepRow[]>(p.steps_json, []),
    }),
  );
  const attempts: GardenData['attempts'] = {};
  for (const pb of playbooks) {
    const first = pb.steps[0];
    if (!first) continue;
    const row = (
      first.skillId
        ? db
            .prepare(
              `SELECT r.id FROM runs r JOIN steps s ON s.run_id = r.id
                WHERE s.skill_id = ? AND r.started_at >= ? AND r.started_at <= ? ORDER BY r.started_at DESC LIMIT 1`,
            )
            .get(first.skillId, from, to)
        : db
            .prepare(
              `SELECT id FROM runs WHERE agent_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC LIMIT 1`,
            )
            .get(first.agentId ?? '', from, to)
    ) as { id: string } | undefined;
    if (!row) continue;
    attempts[pb.id] = {
      runId: row.id,
      steps: store.getSteps(row.id).map((s) => ({
        seq: s.seq,
        kind: s.kind,
        preview: s.preview ?? null,
        toolName: s.tool?.name ?? null,
        callId: s.tool?.callId ?? null,
        skillId: s.tool?.skillId ?? null,
        isError: s.tool?.isError === true || s.error !== undefined,
        errorKind: s.error?.kind ?? null,
      })),
    };
  }

  return {
    attempts,
    families: all<{ id: string; name: string }>(
      'SELECT id, name FROM harness_families ORDER BY name',
    ),
    versions: all<Record<string, unknown>>(
      `SELECT hv.*, (SELECT r.agent_id FROM runs r WHERE r.harness_version_id = hv.id
                      GROUP BY r.agent_id ORDER BY COUNT(*) DESC LIMIT 1) AS primary_agent
         FROM harness_versions hv ORDER BY hv.valid_from`,
    ).map((v) => ({
      id: String(v.id),
      familyId: String(v.family_id),
      validFrom: String(v.valid_from),
      validTo: v.valid_to === null ? null : String(v.valid_to),
      bundle: json<HarnessBundle>(v.bundle_json, {} as HarnessBundle),
      primaryAgentId: v.primary_agent === null ? null : String(v.primary_agent),
    })),
    agents: all<Record<string, unknown>>(
      'SELECT id, name, kind, definition_json FROM agents ORDER BY name',
    ).map((a) => ({
      id: String(a.id),
      name: String(a.name),
      kind: a.kind as 'main' | 'subagent',
      definition: json(a.definition_json, null),
    })),
    skills: all<{ id: string; name: string; description: string | null; scope: string }>(
      'SELECT id, name, description, scope FROM skills ORDER BY name',
    ),
    runs,
    skillCalls: all<{ runId: string; skillId: string; seq: number }>(
      `SELECT s.run_id AS runId, s.skill_id AS skillId, s.seq AS seq FROM steps s JOIN runs r ON r.id = s.run_id
        WHERE s.kind = 'tool_call' AND s.skill_id IS NOT NULL AND r.started_at >= ? AND r.started_at <= ?`,
      from,
      to,
    ),
    mcpCalls: all<{ familyId: string; server: string; n: number }>(
      `SELECT r.family_id AS familyId, s.mcp_server AS server, COUNT(*) AS n FROM steps s JOIN runs r ON r.id = s.run_id
        WHERE s.kind = 'tool_call' AND s.mcp_server IS NOT NULL AND r.started_at >= ? AND r.started_at <= ?
        GROUP BY r.family_id, s.mcp_server`,
      from,
      to,
    ),
    loops: all<Record<string, unknown>>('SELECT * FROM loops ORDER BY name').map((l) => ({
      id: String(l.id),
      name: String(l.name),
      tier: String(l.tier),
      provenance: String(l.provenance),
      triggerKind: String(l.trigger_kind),
      triggerDetail: String(l.trigger_detail),
      expectedIntervalSec:
        l.expected_interval_sec === null ? null : Number(l.expected_interval_sec),
      targets: json(l.targets_json, { agentIds: [], familyIds: [] }),
    })),
    playbooks,
  };
}
