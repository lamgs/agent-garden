import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  Agent,
  HarnessFamily,
  HarnessVersion,
  ID,
  Loop,
  Outcome,
  OutcomeLabel,
  Playbook,
  RedactedText,
  Run,
  Session,
  Skill,
  Source,
  Step,
} from '@garden/core';
import { MIGRATIONS } from './migrations';

export interface FileState {
  path: string;
  adapter: string;
  size: number;
  mtimeMs: number;
  byteOffset: number;
}

type Row = Record<string, SQLInputValue>;
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const opt = <T extends SQLInputValue>(v: T | undefined): T | null => (v === undefined ? null : v);
const parse = <T>(v: unknown): T | undefined =>
  typeof v === 'string' ? (JSON.parse(v) as T) : undefined;
/** Values read back were redacted on the way in. */
const red = (v: unknown): RedactedText => v as RedactedText;

/**
 * The normalized store. Write methods take schema types whose free-form text is `RedactedText`,
 * so only the ingestion pipeline (which redacts) can produce valid arguments.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const current = this.schemaVersion();
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(
          MIGRATIONS[v]!.replace('CREATE TABLE meta ', 'CREATE TABLE IF NOT EXISTS meta '),
        );
        this.db
          .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
          .run(String(v + 1));
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private upsert(table: string, row: Row): void {
    const cols = Object.keys(row);
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...cols.map((c) => row[c]!));
  }

  // ---- writes ---------------------------------------------------------------------------------

  putSource(s: Source): void {
    this.upsert('sources', {
      id: s.id,
      adapter: s.adapter,
      root: s.root,
      adapter_version: s.adapterVersion,
    });
  }

  putAgent(a: Agent): void {
    this.upsert('agents', {
      id: a.id,
      name: a.name,
      kind: a.kind,
      definition_json: json(a.definition),
      first_seen_at: a.firstSeenAt,
      last_seen_at: a.lastSeenAt,
    });
  }

  putFamily(f: HarnessFamily): void {
    this.upsert('harness_families', { id: f.id, name: f.name, project_root: f.projectRoot });
  }

  putHarnessVersion(h: HarnessVersion): void {
    this.upsert('harness_versions', {
      id: h.id,
      family_id: h.familyId,
      valid_from: h.validFrom,
      valid_to: opt(h.validTo),
      provenance: h.provenance,
      bundle_json: JSON.stringify(h.bundle),
      commit_json: json(h.commit),
      diff_json: json(h.diffFromPrevious),
    });
  }

  putSkill(s: Skill): void {
    this.upsert('skills', {
      id: s.id,
      name: s.name,
      dir_name: s.dirName,
      scope: s.scope,
      path: s.path,
      description: opt(s.description),
      content_hash: s.contentHash,
    });
  }

  putPlaybook(p: Playbook): void {
    this.upsert('playbooks', {
      id: p.id,
      name: p.name,
      source: p.source,
      steps_json: JSON.stringify(p.steps),
    });
  }

  putLoop(l: Loop): void {
    this.upsert('loops', {
      id: l.id,
      name: l.name,
      tier: l.tier,
      provenance: l.provenance,
      trigger_kind: l.trigger.kind,
      trigger_detail: l.trigger.detail,
      expected_interval_sec: opt(l.expectedIntervalSec),
      targets_json: JSON.stringify(l.targets),
    });
  }

  putSession(s: Session): void {
    this.upsert('sessions', {
      id: s.id,
      source_id: s.sourceId,
      family_id: s.familyId,
      path: s.path,
      cli_version: opt(s.cliVersion),
      entrypoint: opt(s.entrypoint),
      git_branch: opt(s.gitBranch),
      started_at: s.startedAt,
      ended_at: s.endedAt,
    });
  }

  putRun(r: Run): void {
    this.upsert('runs', {
      id: r.id,
      session_id: r.sessionId,
      agent_id: r.agentId,
      family_id: r.familyId,
      harness_version_id: r.harnessVersionId,
      parent_run_id: opt(r.parentRunId),
      parent_step_id: opt(r.parentStepId),
      loop_id: opt(r.loopId),
      started_at: r.startedAt,
      ended_at: r.endedAt,
      trigger: r.trigger,
      task_preview: r.taskPreview,
      models_json: JSON.stringify(r.models),
      tok_input: r.tokens.input,
      tok_output: r.tokens.output,
      tok_cache_read: r.tokens.cacheRead,
      tok_cache_write_5m: r.tokens.cacheWrite5m,
      tok_cache_write_1h: r.tokens.cacheWrite1h,
      tok_thinking: opt(r.tokens.thinking),
      token_quality: r.tokenQuality,
      step_count: r.stepCount,
      tool_call_count: r.toolCallCount,
      error_count: r.errorCount,
      compaction_count: r.compactionCount,
      peak_context_tokens: r.peakContextTokens,
    });
  }

  putStep(s: Step): void {
    this.upsert('steps', {
      id: s.id,
      run_id: s.runId,
      seq: s.seq,
      at: s.at,
      kind: s.kind,
      loop_tier: s.loopTier,
      preview: opt(s.preview),
      tool_name: opt(s.tool?.name),
      tool_call_id: opt(s.tool?.callId),
      tool_category: opt(s.tool?.category),
      mcp_server: opt(s.tool?.mcpServer),
      skill_id: opt(s.tool?.skillId),
      tool_is_error: s.tool?.isError === undefined ? null : Number(s.tool.isError),
      api_message_id: opt(s.apiMessageId),
      tokens_json: json(s.tokens),
      context_tokens: opt(s.contextTokens),
      error_kind: opt(s.error?.kind),
      error_message: opt(s.error?.message),
      compaction_json: json(s.compaction),
      child_run_id: opt(s.childRunId),
    });
  }

  /** Stores a heuristic outcome. Manual labels live in their own table and are merged on read. */
  putHeuristicOutcome(o: Omit<Outcome, 'source' | 'manual'>): void {
    this.upsert('outcomes', {
      run_id: o.runId,
      label: o.label,
      score: o.score,
      heuristic_version: o.heuristicVersion,
      signals_json: JSON.stringify(o.signals),
    });
  }

  putManualLabel(runId: ID, label: OutcomeLabel, note: RedactedText | undefined, at: string): void {
    this.upsert('manual_labels', { run_id: runId, label, note: opt(note), at });
  }

  clearManualLabel(runId: ID): void {
    this.db.prepare('DELETE FROM manual_labels WHERE run_id = ?').run(runId);
  }

  putFileState(f: FileState): void {
    this.upsert('ingest_files', {
      path: f.path,
      adapter: f.adapter,
      size: f.size,
      mtime_ms: f.mtimeMs,
      byte_offset: f.byteOffset,
      ingested_at: new Date().toISOString(),
    });
  }

  // ---- reads ----------------------------------------------------------------------------------

  getFileState(path: string): FileState | undefined {
    const r = this.db.prepare('SELECT * FROM ingest_files WHERE path = ?').get(path);
    if (!r) return undefined;
    return {
      path: String(r.path),
      adapter: String(r.adapter),
      size: Number(r.size),
      mtimeMs: Number(r.mtime_ms),
      byteOffset: Number(r.byte_offset),
    };
  }

  getRun(id: ID): Run | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      sessionId: String(r.session_id),
      agentId: String(r.agent_id),
      familyId: String(r.family_id),
      harnessVersionId: String(r.harness_version_id),
      ...(r.parent_run_id ? { parentRunId: String(r.parent_run_id) } : {}),
      ...(r.parent_step_id ? { parentStepId: String(r.parent_step_id) } : {}),
      ...(r.loop_id ? { loopId: String(r.loop_id) } : {}),
      startedAt: String(r.started_at),
      endedAt: String(r.ended_at),
      trigger: r.trigger as Run['trigger'],
      taskPreview: red(r.task_preview),
      models: parse<string[]>(r.models_json) ?? [],
      tokens: {
        input: Number(r.tok_input),
        output: Number(r.tok_output),
        cacheRead: Number(r.tok_cache_read),
        cacheWrite5m: Number(r.tok_cache_write_5m),
        cacheWrite1h: Number(r.tok_cache_write_1h),
        ...(r.tok_thinking === null ? {} : { thinking: Number(r.tok_thinking) }),
      },
      tokenQuality: r.token_quality as Run['tokenQuality'],
      stepCount: Number(r.step_count),
      toolCallCount: Number(r.tool_call_count),
      errorCount: Number(r.error_count),
      compactionCount: Number(r.compaction_count),
      peakContextTokens: Number(r.peak_context_tokens),
    };
  }

  getSteps(runId: ID): Step[] {
    return this.db
      .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq')
      .all(runId)
      .map((r) => ({
        id: String(r.id),
        runId: String(r.run_id),
        seq: Number(r.seq),
        at: String(r.at),
        kind: r.kind as Step['kind'],
        loopTier: r.loop_tier as Step['loopTier'],
        ...(r.preview === null ? {} : { preview: red(r.preview) }),
        ...(r.tool_name === null
          ? {}
          : {
              tool: {
                name: String(r.tool_name),
                callId: String(r.tool_call_id),
                category: r.tool_category as NonNullable<Step['tool']>['category'],
                ...(r.mcp_server === null ? {} : { mcpServer: String(r.mcp_server) }),
                ...(r.skill_id === null ? {} : { skillId: String(r.skill_id) }),
                ...(r.tool_is_error === null ? {} : { isError: Boolean(r.tool_is_error) }),
              },
            }),
        ...(r.api_message_id === null ? {} : { apiMessageId: String(r.api_message_id) }),
        ...(r.tokens_json === null ? {} : { tokens: parse(r.tokens_json) }),
        ...(r.context_tokens === null ? {} : { contextTokens: Number(r.context_tokens) }),
        ...(r.error_kind === null
          ? {}
          : {
              error: {
                kind: r.error_kind as NonNullable<Step['error']>['kind'],
                message: red(r.error_message),
              },
            }),
        ...(r.compaction_json === null ? {} : { compaction: parse(r.compaction_json) }),
        ...(r.child_run_id === null ? {} : { childRunId: String(r.child_run_id) }),
      }));
  }

  /** The effective outcome: a manual label overrides the heuristic, and both stay visible. */
  getOutcome(runId: ID): Outcome | undefined {
    const h = this.db.prepare('SELECT * FROM outcomes WHERE run_id = ?').get(runId);
    const m = this.db.prepare('SELECT * FROM manual_labels WHERE run_id = ?').get(runId);
    if (!h && !m) return undefined;
    const manual = m
      ? {
          label: m.label as OutcomeLabel,
          ...(m.note === null ? {} : { note: red(m.note) }),
          at: String(m.at),
        }
      : undefined;
    return {
      runId,
      label: manual ? manual.label : (h!.label as OutcomeLabel),
      score: h && h.score !== null ? Number(h.score) : null,
      source: manual ? 'manual' : 'heuristic',
      heuristicVersion: h ? String(h.heuristic_version) : 'none',
      signals: h ? (parse(h.signals_json) ?? []) : [],
      ...(manual ? { manual } : {}),
    };
  }

  count(table: string): number {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  }
}
