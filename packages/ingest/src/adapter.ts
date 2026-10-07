/**
 * Adapter interface. An adapter reads one kind of source (Claude Code files, OTel GenAI spans,
 * LangSmith exports, ...) and yields normalized records with plain-string text. Adapters never
 * produce RedactedText: the pipeline redacts every record before it reaches the store.
 */
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
import type { Unredacted } from './redact';
import type { FileState } from './store/store';

export type NormalizedRecord =
  | { type: 'source'; value: Unredacted<Source> }
  | { type: 'agent'; value: Unredacted<Agent> }
  | { type: 'family'; value: Unredacted<HarnessFamily> }
  | { type: 'harness_version'; value: Unredacted<HarnessVersion> }
  | { type: 'skill'; value: Unredacted<Skill> }
  | { type: 'playbook'; value: Unredacted<Playbook> }
  | { type: 'loop'; value: Unredacted<Loop> }
  | { type: 'session'; value: Unredacted<Session> }
  | { type: 'run'; value: Unredacted<Run> }
  | { type: 'step'; value: Unredacted<Step> }
  | { type: 'outcome'; value: Unredacted<Omit<Outcome, 'source' | 'manual'>> }
  /** Emitted after a file is fully consumed; enables incremental re-ingestion. */
  | { type: 'file_state'; value: FileState };

export interface AdapterContext {
  /** Previously ingested state for a file, for incremental reads. */
  fileState(path: string): FileState | undefined;
  /** Non-fatal problems (unknown record types, malformed lines). Never throw for these. */
  warn(message: string): void;
}

/** What `garden inspect` prints: shapes and counts only, never content. */
export interface Census {
  adapter: string;
  roots: { path: string; exists: boolean; files: number; bytes: number }[];
  /** e.g. { 'line.type=assistant': 120, 'attachment.type=skill_listing': 3 } */
  recordTypes: Record<string, number>;
  /** Fields seen that the adapter does not understand, with counts. */
  unknownFields: Record<string, number>;
  versions: Record<string, number>;
  warnings: string[];
}

export interface Adapter {
  readonly id: string;
  readonly version: string;
  /** Yield normalized records. Must tolerate unknown shapes (count and warn, never throw). */
  read(ctx: AdapterContext): AsyncIterable<NormalizedRecord>;
  /** Describe what is on disk without reading content into the store. */
  inspect(): Promise<Census>;
}
