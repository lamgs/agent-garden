import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveMessage } from '@garden/core';
import { Redactor } from '../redact';
import { familyId } from '../adapters/claude-code/harness';
import { stableId } from '../ids';
import { L } from './fixtures';
import { LiveTailer } from './tailer';

let dir: string;
let proj: string;
let t: number;
const at = (dt = 0) => new Date(t + dt).toISOString();
const o = (dt = 0, extra: { agentId?: string; cwd?: string } = {}) => ({ at: at(dt), ...extra });
const redactor = new Redactor(Buffer.alloc(32, 7));
const ses = stableId('ses', 'sess-1');

function tailer(extra: Partial<ConstructorParameters<typeof LiveTailer>[0]> = {}) {
  const tl = new LiveTailer({
    redactor,
    projectsDir: dir,
    sessionsDir: null,
    watch: false,
    pollMs: 0,
    scanMs: 0,
    now: () => t,
    ...extra,
  });
  tl.hub.stop(); // no timers in tests; tick() is called explicitly
  const msgs: LiveMessage[] = [];
  tl.hub.subscribe((m) => msgs.push(m));
  return { tl, msgs, events: () => msgs.flatMap((m) => (m.type === 'event' ? [m.event] : [])) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'garden-live-'));
  proj = join(dir, '-work-demo-repo');
  mkdirSync(proj);
  t = Date.now();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('LiveTailer', () => {
  it('emits events for appended lines only, keyed by session, with the adapter bed id', async () => {
    const f = join(proj, 'sess-1.jsonl');
    writeFileSync(f, L.prompt(o(), 'fix the flaky test') + '\n');
    const { tl, events } = tailer();
    await tl.start();
    expect(events().map((e) => e.kind)).toEqual(['session_seen', 'turn_start']);
    appendFileSync(
      f,
      L.toolUse(o(100), 'msg_1', 'call_1', 'Read', { file_path: 'src/a.ts' }) + '\n',
    );
    await tl.poll();
    const ev = events();
    expect(ev.map((e) => e.kind)).toEqual(['session_seen', 'turn_start', 'tool_start']);
    expect(ev[2]).toMatchObject({ agentKey: ses, preview: 'src/a.ts', contextTokens: 2010 });
    const a = tl.hub.snapshot().agents[0]!;
    expect(a).toMatchObject({
      activity: 'reading',
      bedId: familyId('/work/demo-repo'),
      bedName: 'demo-repo',
    });
    await tl.poll(); // nothing new
    expect(events()).toHaveLength(3);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('buffers a partial trailing line until its newline arrives', async () => {
    const f = join(proj, 'sess-1.jsonl');
    writeFileSync(f, '');
    const { tl, events } = tailer();
    await tl.start();
    const line = L.prompt(o(), 'héllo wörld, multibyte ✓');
    const bytes = Buffer.from(line + '\n');
    const cut = bytes.indexOf(Buffer.from('✓')) + 1; // split inside a multibyte character
    appendFileSync(f, bytes.subarray(0, cut));
    await tl.poll();
    expect(events()).toHaveLength(0);
    appendFileSync(f, bytes.subarray(cut));
    await tl.poll();
    expect(events().map((e) => e.kind)).toEqual(['session_seen', 'turn_start']);
    expect(events()[1]!.preview).toBe('héllo wörld, multibyte ✓');
  });

  it('handles truncation by re-reading the file', async () => {
    const f = join(proj, 'sess-1.jsonl');
    writeFileSync(f, L.prompt(o(), 'one') + '\n' + L.text(o(10), 'm1', 'done', 'end_turn') + '\n');
    const { tl, events } = tailer();
    await tl.start();
    const before = events().length;
    truncateSync(f, 0);
    appendFileSync(f, L.prompt(o(20), 'two') + '\n');
    await tl.poll();
    expect(tl.stats.truncations).toBe(1);
    expect(
      events()
        .slice(before)
        .map((e) => [e.kind, e.preview]),
    ).toEqual([['turn_start', 'two']]);
    expect(tl.census.unknownFields['file truncated or rotated (re-read)']).toBe(1);
  });

  it('discovers new files, ignores old ones, and seeds from the tail only', async () => {
    const old = join(proj, 'old.jsonl');
    writeFileSync(old, L.prompt(o(), 'ancient') + '\n');
    const past = (t - 2 * 3600_000) / 1000;
    utimesSync(old, past, past);
    const big = join(proj, 'sess-1.jsonl');
    const lines =
      Array.from({ length: 200 }, (_, i) => L.prompt(o(i), `prompt ${i}`)).join('\n') + '\n';
    writeFileSync(big, lines);
    const { tl, events } = tailer({ seedBytes: 2000 });
    await tl.start();
    expect(tl.trackedFiles).toEqual([big]);
    const prompts = events().filter((e) => e.kind === 'turn_start');
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThan(20); // tail only
    expect(prompts.at(-1)!.preview).toBe('prompt 199');

    const fresh = join(proj, 'sess-2.jsonl');
    writeFileSync(fresh, L.prompt({ ...o(500), sessionId: 'sess-2' }, 'new session') + '\n');
    await tl.scan();
    expect(tl.trackedFiles).toContain(fresh);
    expect(events().at(-1)).toMatchObject({
      kind: 'turn_start',
      agentKey: stableId('ses', 'sess-2'),
    });

    // The old file becomes active again: only its new bytes are read.
    appendFileSync(old, L.prompt(o(600), 'revived') + '\n');
    await tl.scan();
    const revived = events().filter((e) => e.agentKey === stableId('ses', 'old'));
    expect(revived.map((e) => e.preview).filter(Boolean)).toEqual(['revived']);
  });

  it('links subagent files to the parent via meta.toolUseId and ends them on the parent result', async () => {
    const f = join(proj, 'sess-1.jsonl');
    writeFileSync(
      f,
      [
        L.prompt(o(), 'review this'),
        L.toolUse(o(10), 'msg_1', 'toolu_spawn', 'Agent', {
          subagent_type: 'code-reviewer',
          description: 'review diff',
          prompt: 'review',
        }),
      ].join('\n') + '\n',
    );
    const { tl, events } = tailer();
    await tl.start();
    const sub = join(proj, 'sess-1', 'subagents');
    mkdirSync(sub, { recursive: true });
    const sf = join(sub, 'agent-abc123.jsonl');
    writeFileSync(
      sf,
      L.prompt(o(20, { agentId: 'abc123' }), 'review') +
        '\n' +
        L.toolUse(
          o(30, { agentId: 'abc123' }),
          'msg_s1',
          'call_s1',
          'Grep',
          { pattern: 'TODO' },
          null,
        ) +
        '\n',
    );
    await tl.scan(); // meta not written yet
    const childKey = `${ses}:abc123`;
    let child = tl.hub.snapshot().agents.find((a) => a.key === childKey)!;
    expect(child).toMatchObject({ agentKind: 'subagent', parentKey: ses, activity: 'searching' });
    writeFileSync(
      join(sub, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'code-reviewer', toolUseId: 'toolu_spawn', spawnDepth: 1 }),
    );
    appendFileSync(sf, L.toolResult(o(40, { agentId: 'abc123' }), 'call_s1', 'found 2') + '\n');
    await tl.poll();
    child = tl.hub.snapshot().agents.find((a) => a.key === childKey)!;
    expect(child.agentName).toBe('code-reviewer');
    expect(tl.hub.snapshot().agents.find((a) => a.key === ses)!.activity).toBe('delegating');

    appendFileSync(
      f,
      L.toolResult(o(50), 'toolu_spawn', 'looks good', {
        toolUseResult: { agentId: 'abc123', status: 'completed' },
      }) + '\n',
    );
    await tl.poll();
    expect(events().at(-1)).toMatchObject({ kind: 'subagent_end', agentKey: ses });
    child = tl.hub.snapshot().agents.find((a) => a.key === childKey)!;
    expect(child.activity).toBe('done');
  });

  it('keeps async subagents running until their task notification', async () => {
    const f = join(proj, 'sess-1.jsonl');
    writeFileSync(
      f,
      [
        L.prompt(o(), 'explore'),
        L.toolUse(o(10), 'msg_1', 'toolu_bg', 'Agent', {
          subagent_type: 'Explore',
          run_in_background: true,
        }),
        L.toolResult(o(20), 'toolu_bg', 'launched', {
          toolUseResult: { agentId: 'bg1', status: 'async_launched', isAsync: true },
        }),
        L.text(o(30), 'msg_2', 'started a background explorer', 'end_turn'),
      ].join('\n') + '\n',
    );
    const sub = join(proj, 'sess-1', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'agent-bg1.jsonl'),
      L.prompt(o(25, { agentId: 'bg1' }), 'explore') + '\n',
    );
    const { tl } = tailer();
    await tl.start();
    const snap = () => Object.fromEntries(tl.hub.snapshot().agents.map((a) => [a.key, a]));
    expect(snap()[ses]!.activity).toBe('waiting_input');
    expect(snap()[`${ses}:bg1`]).toMatchObject({ activity: 'thinking', agentName: 'Explore' });
    appendFileSync(f, L.taskNotification(o(60), 'toolu_bg', 'completed') + '\n');
    await tl.poll();
    expect(snap()[`${ses}:bg1`]!.activity).toBe('done');
  });

  it('counts unknown and malformed lines instead of throwing, and ignores last-prompt lines', async () => {
    const f = join(proj, 'sess-1.jsonl');
    writeFileSync(f, [L.unknown(o()), '{not json', '[1,2]', L.lastPrompt()].join('\n') + '\n');
    const { tl, events } = tailer();
    await tl.start();
    expect(events()).toHaveLength(0);
    expect(tl.census.unknownFields).toMatchObject({
      'line.type=brand-new-type': 1,
      'malformed JSON line': 1,
      'non-object line': 1,
    });
  });
});
