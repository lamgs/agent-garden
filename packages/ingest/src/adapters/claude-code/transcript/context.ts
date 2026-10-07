import type { ParsedStep, TranscriptCensus } from '../contracts';
import { stableId } from '../../../ids';

/** A subagent_spawn step waiting to be linked to the subagent run it started. */
export interface SpawnRef {
  step: ParsedStep;
  runId: string;
  linked: boolean;
}

const MAX_WARNINGS = 200;

/** Shared, session-wide state for all threads (main + subagents) of one transcript. */
export class SessionContext {
  readonly sesId: string;
  readonly census: TranscriptCensus = { recordTypes: {}, unknownFields: {}, versions: {} };
  readonly warnings: string[] = [];
  /** API message ids whose usage has been attached to a step (dedupe by message.id). */
  readonly seenMessageIds = new Set<string>();
  /** tool_use id → spawn step. */
  readonly spawns = new Map<string, SpawnRef>();
  /** tool_use id of a spawn → agentId reported in its tool result. */
  readonly agentIdByCallId = new Map<string, string>();
  firstCwd?: string;
  firstGitBranch?: string;
  firstEntrypoint?: string;
  lastVersion?: string;
  private minTs?: { ms: number; iso: string };
  private maxTs?: { ms: number; iso: string };
  private droppedWarnings = 0;

  constructor(readonly rawSessionId: string) {
    this.sesId = stableId('ses', rawSessionId);
  }

  count(key: string): void {
    this.census.recordTypes[key] = (this.census.recordTypes[key] ?? 0) + 1;
  }

  unknown(key: string): void {
    this.census.unknownFields[key] = (this.census.unknownFields[key] ?? 0) + 1;
  }

  version(v: string): void {
    this.census.versions[v] = (this.census.versions[v] ?? 0) + 1;
    this.lastVersion = v;
  }

  warn(msg: string): void {
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(msg);
    else this.droppedWarnings++;
  }

  timestamp(iso: string): void {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return;
    if (!this.minTs || ms < this.minTs.ms) this.minTs = { ms, iso };
    if (!this.maxTs || ms > this.maxTs.ms) this.maxTs = { ms, iso };
  }

  get startedAt(): string | undefined {
    return this.minTs?.iso;
  }

  get endedAt(): string | undefined {
    return this.maxTs?.iso;
  }

  finalizeWarnings(): void {
    if (this.droppedWarnings > 0) {
      this.warnings.push(`${this.droppedWarnings} further warnings suppressed`);
      this.droppedWarnings = 0;
    }
  }
}
