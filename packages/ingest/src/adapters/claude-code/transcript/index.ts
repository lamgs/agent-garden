import type { ParsedSession } from '../contracts';

/**
 * Parse one session: the main transcript at `mainPath` plus its subagent transcripts in
 * `<dir>/<sessionId>/subagents/agent-*.jsonl` (with `.meta.json` sidecars). Tolerant: unknown
 * records are counted in `census.unknownFields` and reported in `warnings`, never thrown.
 */
export async function parseSession(mainPath: string): Promise<ParsedSession> {
  throw new Error(`parseSession not implemented (${mainPath})`);
}
