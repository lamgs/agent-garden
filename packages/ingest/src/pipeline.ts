import type {
  Agent,
  HarnessFamily,
  HarnessVersion,
  Loop,
  Outcome,
  Playbook,
  Run,
  Session,
  Skill,
  Source,
  Step,
} from '@garden/core';
import type { Adapter, NormalizedRecord } from './adapter';
import type { Redactor } from './redact';
import type { Store } from './store/store';

export interface IngestReport {
  adapter: string;
  records: Record<string, number>;
  warnings: string[];
  redactions: Record<string, number>;
}

/** Write one record. The only place adapter output crosses into the store, and always redacted. */
export function writeRecord(store: Store, redactor: Redactor, rec: NormalizedRecord): void {
  switch (rec.type) {
    case 'source':
      return store.putSource(redactor.deep<Source>(rec.value));
    case 'agent':
      return store.putAgent(redactor.deep<Agent>(rec.value));
    case 'family':
      return store.putFamily(redactor.deep<HarnessFamily>(rec.value));
    case 'harness_version':
      return store.putHarnessVersion(redactor.deep<HarnessVersion>(rec.value));
    case 'skill':
      return store.putSkill(redactor.deep<Skill>(rec.value));
    case 'playbook':
      return store.putPlaybook(redactor.deep<Playbook>(rec.value));
    case 'loop':
      return store.putLoop(redactor.deep<Loop>(rec.value));
    case 'session':
      return store.putSession(redactor.deep<Session>(rec.value));
    case 'run':
      return store.putRun(redactor.deep<Run>(rec.value));
    case 'step':
      return store.putStep(redactor.deep<Step>(rec.value));
    case 'outcome':
      return store.putHeuristicOutcome(
        redactor.deep<Omit<Outcome, 'source' | 'manual'>>(rec.value),
      );
    case 'file_state':
      // Paths of the user's own files on the local machine; used only for incremental reads.
      return store.putFileState(rec.value);
  }
}

export async function ingest(
  adapter: Adapter,
  store: Store,
  redactor: Redactor,
): Promise<IngestReport> {
  const report: IngestReport = { adapter: adapter.id, records: {}, warnings: [], redactions: {} };
  const ctx = {
    fileState: (p: string) => store.getFileState(p),
    warn: (m: string) => void report.warnings.push(m),
  };
  // Batch writes in transactions for speed; a crash mid-file leaves file_state unadvanced.
  let batch: NormalizedRecord[] = [];
  const flush = () => {
    const recs = batch;
    batch = [];
    store.transaction(() => recs.forEach((r) => writeRecord(store, redactor, r)));
  };
  for await (const rec of adapter.read(ctx)) {
    report.records[rec.type] = (report.records[rec.type] ?? 0) + 1;
    batch.push(rec);
    if (batch.length >= 500 || rec.type === 'file_state') flush();
  }
  flush();
  report.redactions = { ...redactor.stats.byKind };
  return report;
}
