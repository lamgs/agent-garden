/**
 * Smoke test against the developer's real Claude Code transcripts, if present. Skipped when
 * ~/.claude/projects does not exist (CI). Reads only; asserts structure and token dedupe.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSession } from './index';

const ROOT = join(homedir(), '.claude', 'projects');

function mainTranscripts(): string[] {
  const out: string[] = [];
  for (const proj of readdirSync(ROOT)) {
    const dir = join(ROOT, proj);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(join(dir, f));
  }
  return out;
}

interface U {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** Independent dedupe: first usage seen per message.id, across the main file and subagent files. */
function usageByMessageId(mainPath: string): Map<string, U> {
  const files = [mainPath];
  const subDir = join(mainPath.replace(/\.jsonl$/, ''), 'subagents');
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(join(subDir, f));
  }
  const map = new Map<string, U>();
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      let r: unknown;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = r as { type?: string; message?: { id?: string; usage?: Record<string, number> } };
      const id = rec.message?.id;
      const u = rec.message?.usage;
      if (rec.type !== 'assistant' || !id || !u || map.has(id)) continue;
      map.set(id, {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
      });
    }
  }
  return map;
}

describe.skipIf(!existsSync(ROOT))('real transcripts in ~/.claude/projects', () => {
  it('parse without throwing and token totals match an independent dedupe', async () => {
    const paths = mainTranscripts();
    for (const path of paths) {
      // Read the independent view first: live sessions only grow, so the parser sees a superset.
      const expected = usageByMessageId(path);
      const s = await parseSession(path);
      expect(s.id).toMatch(/^ses_[0-9a-f]{16}$/);
      const seen = new Set<string>();
      for (const run of s.runs) {
        const ids = new Set<string>();
        for (const st of run.steps) {
          if (!st.tokens) continue;
          expect(st.apiMessageId, 'tokens without message id').toBeDefined();
          expect(seen.has(st.apiMessageId!), `message ${st.apiMessageId} counted twice`).toBe(
            false,
          );
          seen.add(st.apiMessageId!);
          ids.add(st.apiMessageId!);
        }
        if ([...ids].some((id) => !expected.has(id))) continue; // appended after our read
        const sum = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        for (const id of ids) {
          const u = expected.get(id)!;
          sum.input += u.input;
          sum.output += u.output;
          sum.cacheRead += u.cacheRead;
          sum.cacheCreate += u.cacheCreate;
        }
        // Estimated runs (stream-start usage snapshots) carry a lower-bound output estimate at run
        // level; their recorded step tokens must still match the dedupe exactly.
        const stepOutput = run.steps.reduce((n, st) => n + (st.tokens?.output ?? 0), 0);
        if (run.outputTokensEstimated) expect(run.tokens.output).toBeGreaterThan(stepOutput);
        expect({
          input: run.tokens.input,
          output: run.outputTokensEstimated ? stepOutput : run.tokens.output,
          cacheRead: run.tokens.cacheRead,
          cacheCreate: run.tokens.cacheWrite5m + run.tokens.cacheWrite1h,
        }).toEqual(sum);
        expect(run.stepCount).toBe(run.steps.length);
      }
      // Every message in the files is attributed to some run.
      for (const id of expected.keys())
        expect(seen.has(id), `message ${id} not attributed`).toBe(true);
    }
  });
});
