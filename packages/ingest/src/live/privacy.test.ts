import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@garden/core';
import { Redactor } from '../redact';
import { plantedSecrets } from '../redact/planted-secrets';
import { L } from './fixtures';
import { LIVE_PREVIEW_MAX } from './types';
import { livePreview } from './preview';
import { LiveTailer } from './tailer';

const redactor = new Redactor(Buffer.alloc(32, 9));
const dir = mkdtempSync(join(tmpdir(), 'garden-live-privacy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every planted secret, in every place a transcript can carry text. */
function transcript(t: number): string {
  const at = (i: number) => ({ at: new Date(t + i * 10).toISOString() });
  const lines: string[] = [];
  plantedSecrets('live').forEach((s, i) => {
    const b = i * 20;
    lines.push(
      L.prompt(at(b), s.context),
      L.thinking(at(b + 1), `m${i}a`, `THINKING-TEXT-MARKER ${s.context}`),
      L.text(at(b + 2), `m${i}b`, s.context, 'tool_use'),
      L.toolUse(at(b + 3), `m${i}c`, `bash${i}`, 'Bash', { command: s.context }),
      L.toolResult(at(b + 4), `bash${i}`, s.context, { isError: true }),
      L.toolUse(at(b + 5), `m${i}d`, `write${i}`, 'Write', {
        file_path: 'notes.txt',
        content: s.context,
      }),
      L.toolResult(at(b + 6), `write${i}`, s.context),
      L.toolUse(at(b + 7), `m${i}e`, `web${i}`, 'WebFetch', {
        url: `https://x.test/?q=${s.context}`,
      }),
      L.toolResult(at(b + 8), `web${i}`, s.context, { isError: true }),
      L.toolUse(at(b + 9), `m${i}f`, `env${i}`, 'Read', { file_path: '.env' }),
      L.toolResult(at(b + 10), `env${i}`, s.context, { isError: true }),
      L.apiError(at(b + 11), s.context),
      L.text(at(b + 12), `m${i}g`, `Done. ${s.context}`, 'end_turn'),
    );
  });
  return lines.join('\n') + '\n';
}

describe('live layer privacy', () => {
  it('planted secrets in a tailed transcript never appear in any emitted message', async () => {
    const proj = join(dir, '-work-secret-repo');
    mkdirSync(proj, { recursive: true });
    const t = Date.now();
    writeFileSync(join(proj, 'sess-secret.jsonl'), '');
    const tl = new LiveTailer({
      redactor,
      projectsDir: dir,
      sessionsDir: null,
      watch: false,
      pollMs: 0,
      scanMs: 0,
      now: () => t,
    });
    tl.hub.stop();
    const msgs: LiveMessage[] = [];
    tl.hub.subscribe((m) => msgs.push(m));
    await tl.start();
    const before = readdirSync(dir, { recursive: true }).sort();
    writeFileSync(join(proj, 'sess-secret.jsonl'), transcript(t));
    await tl.poll();
    tl.hub.tick();

    const bytes = Buffer.from(JSON.stringify(msgs) + JSON.stringify(tl.hub.snapshot()), 'utf8');
    const text = bytes.toString('utf8');
    expect(msgs.length).toBeGreaterThan(200);
    for (const s of plantedSecrets('live')) {
      expect(bytes.includes(Buffer.from(s.secret)), s.kind).toBe(false);
      if (s.secret.length >= 24) expect(text.includes(s.secret.slice(0, 16)), s.kind).toBe(false);
    }
    expect(text).not.toContain('THINKING-TEXT-MARKER');
    expect(text).toContain('[REDACTED:'); // redaction ran, not just truncation
    expect(text).toContain('[sensitive path]');
    for (const m of msgs) {
      if (m.type !== 'event') continue;
      if (m.event.kind === 'thinking') expect(m.event.preview).toBeUndefined();
      if (m.event.preview) expect(m.event.preview.length).toBeLessThanOrEqual(LIVE_PREVIEW_MAX);
    }
    // Nothing written to disk by the live layer.
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });
});

describe('livePreview', () => {
  it('redacts before cutting, never splits a redaction marker, and caps at 120 chars', () => {
    for (const s of plantedSecrets('cut')) {
      for (const pad of [0, 50, 95, 110, 118]) {
        const p = livePreview(redactor, `${'x'.repeat(pad)} ${s.context} trailing words`);
        expect(p.length).toBeLessThanOrEqual(120);
        expect(p.includes(s.secret)).toBe(false);
        const opens = p.split('[REDACTED:').length - 1;
        expect(p.split(']').length - 1, `${s.kind} ${pad}: ${p}`).toBeGreaterThanOrEqual(opens);
      }
    }
    expect(livePreview(redactor, 'short\n\n  text')).toBe('short text');
    expect(livePreview(redactor, 'y'.repeat(300))).toBe(`${'y'.repeat(119)}…`);
  });
});
