/**
 * Live layer DOM chrome: the status pill, the "Needs you" strip, the event ticker, and the plant
 * panel's "Now" section. All read the live store through `useLive()`; none of them touch the
 * renderer (the overlay subscribes to the store itself).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { GardenView, ID, LiveAgent, LiveEvent, LiveEventKind } from '@garden/core';
import { formatInt, pct, shortModel } from '../format';
import { attentionQueue } from '../live/live-client';
import { liveStore, useLive, type LivePill as PillState } from '../live/live-store';
import {
  activityLabel,
  anchorFor,
  attentionOf,
  fillOf,
  formatWait,
  liveCounts,
} from '../live/overlay-model';
import { ATTENTION_FILL, ATTENTION_INK } from '../garden/live-draw';
import { latestReplayHref } from '../route';
import './live.css';

/** Re-render every `ms` (wait timers tick between stream updates). */
function useClock(ms: number): number {
  const [, set] = useState(0);
  useEffect(() => {
    const h = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(h);
  }, [ms]);
  return liveStore().now();
}

const PILL_WORD: Record<PillState, string> = {
  connecting: 'Live · connecting…',
  live: 'Live',
  fixture: 'Fixture · demo stream',
  reconnecting: 'Live · reconnecting…',
  off: 'Live off',
};

export function LivePill() {
  const s = useLive();
  const c = liveCounts(s.snapshot);
  const source = s.snapshot?.source;
  const parts = [PILL_WORD[s.pill]];
  if (s.snapshot && s.pill !== 'off') {
    if (source && !(s.pill === 'fixture' && source === 'demo')) parts.push(source);
    parts.push(`${c.agents} active`);
    if (c.waiting) parts.push(`${c.waiting} waiting`);
  }
  const title =
    s.pill === 'off'
      ? `${s.detail}. Click to turn the live layer on.`
      : `${s.detail}${s.rejected ? ` · ${s.rejected} malformed messages ignored` : ''}. Click to turn the live layer off.`;
  return (
    <button
      type="button"
      className={`live-pill live-pill-${s.pill}`}
      onClick={() => liveStore().toggle()}
      aria-pressed={s.pill !== 'off'}
      title={title}
      data-live-pill={s.pill}
    >
      <span className="live-dot" aria-hidden="true" />
      {parts.join(' · ')}
    </button>
  );
}

/** Rows shown before "+N more": few enough that the garden can fit beside or below the strip. */
const NEEDS_SHOWN = 3;

/**
 * "Needs you": waiting for permission or input, permission first, longest wait first.
 * `onBox` reports the strip's outer box (right and bottom edges, relative to its offset parent)
 * so the garden's fit can keep plants out from under it.
 */
export function NeedsYou({
  view,
  onSelect,
  onBox,
}: {
  view: GardenView;
  onSelect: (id: ID) => void;
  onBox?: (right: number, bottom: number) => void;
}) {
  const s = useLive();
  const now = useClock(1000);
  const [all, setAll] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // Reserve room for the collapsed strip only: expanding it is a deliberate, temporary look.
    if (!el || !onBox || all) return;
    const report = () => onBox(el.offsetLeft + el.offsetWidth, el.offsetTop + el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, onBox, all]);
  if (!s.snapshot) return null;
  const items = attentionQueue(s.snapshot, now);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, NEEDS_SHOWN);
  const hidden = items.length - shown.length;
  return (
    <section
      ref={setEl}
      className="needs-you"
      aria-label="Needs you"
      style={{ '--att-ink': ATTENTION_INK, '--att-fill': ATTENTION_FILL } as CSSProperties}
    >
      <h2>
        Needs you <span className="needs-n">{items.length}</span>
      </h2>
      <ol>
        {shown.map((it) => {
          const a = it.agent;
          const anc = anchorFor(a, view);
          const plantId = anc.kind === 'plant' ? anc.plantId : null;
          const what = it.reason === 'waiting_permission' ? 'permission' : 'input';
          return (
            <li key={it.key}>
              <button
                type="button"
                className="needs-item"
                title={`${a.evidence}${a.detail ? `\nNow: ${a.detail}` : ''}`}
                onClick={() => plantId && onSelect(plantId)}
                disabled={!plantId}
                data-reason={it.reason}
                data-inferred={it.inferred}
              >
                <span
                  className={`att-tag att-${what}${it.inferred ? ' att-inferred' : ''}`}
                  aria-hidden="true"
                >
                  {it.reason === 'waiting_permission' ? '!' : '?'}
                </span>
                <span className="needs-who">
                  <b>{a.agentName}</b> <span className="needs-bed">{a.bedName}</span>
                </span>
                <span className="needs-what">
                  {what}
                  {it.inferred ? <em> · inferred</em> : null}
                </span>
                <span className="needs-wait">{formatWait(it.waitingMs)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {hidden > 0 || all ? (
        <button type="button" className="needs-more link-btn" onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `+${hidden} more`}
        </button>
      ) : null}
    </section>
  );
}

const KIND_LABEL: Record<LiveEventKind, string> = {
  session_seen: 'session',
  turn_start: 'prompt',
  thinking: 'thinking',
  assistant_text: 'reply',
  tool_start: 'tool',
  tool_end: 'result',
  subagent_start: 'subagent ↗',
  subagent_end: 'subagent ↘',
  compaction: 'compaction',
  error: 'error',
  turn_end: 'turn end',
  hook: 'hook',
};

function clockTime(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function TickerLine({ e }: { e: LiveEvent }) {
  const s = liveStore().get();
  const who = s.names.get(e.agentKey);
  const text =
    e.preview ??
    (e.tool ? e.tool.name : e.kind === 'thinking' ? '(thinking text is never shown)' : '');
  return (
    <li className={e.isError ? 'tick-error' : undefined}>
      <time dateTime={e.at}>{clockTime(e.at)}</time>
      <span className="tick-who">{who ? `${who.bedName} · ${who.agentName}` : e.agentKey}</span>
      <span className="tick-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
      <span className="tick-text">{text}</span>
    </li>
  );
}

/** Recent live events (redacted previews), newest first; collapsed shows the latest one. */
export function EventTicker() {
  const s = useLive();
  const [open, setOpen] = useState(false);
  if (!s.snapshot) return null;
  const recent = s.snapshot.recent;
  const shown = [...recent].reverse().slice(0, open ? 14 : 1);
  return (
    <section className={`ticker${open ? ' open' : ''}`} aria-label="Live events">
      <button
        type="button"
        className="ticker-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Events <span aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
      <ol className="ticker-list" data-latest-seq={recent[recent.length - 1]?.seq ?? 0}>
        {shown.map((e) => (
          <TickerLine key={e.seq} e={e} />
        ))}
      </ol>
      {open ? (
        <p className="ticker-note">
          Previews are redacted and cut to 120 characters at the source. Thinking text and tool
          output (except errors) are never sent.
        </p>
      ) : null}
    </section>
  );
}

function NowAgent({ a, source }: { a: LiveAgent; source: 'transcripts' | 'hooks' | 'demo' }) {
  const now = liveStore().now();
  const att = attentionOf(a, source);
  const fill = fillOf(a);
  const tool = a.currentTool;
  return (
    <div className="now-agent" data-agent-key={a.key}>
      <p className="now-activity">
        <b>{activityLabel(a.activity)}</b>
        {att?.inferred ? <em> (inferred)</em> : null}
        <span className="muted"> for {formatWait(now - Date.parse(a.activitySince))}</span>
      </p>
      <dl className="now-rows">
        {a.detail ? (
          <>
            <dt>Doing</dt>
            <dd>{a.detail}</dd>
          </>
        ) : null}
        {tool ? (
          <>
            <dt>Tool</dt>
            <dd>
              {tool.name}
              {tool.mcpServer ? ` (MCP: ${tool.mcpServer})` : ''}
              {tool.skillName ? ` (skill: ${tool.skillName})` : ''}
            </dd>
          </>
        ) : null}
        <dt>Context</dt>
        <dd>
          {pct(fill)} of {formatInt(a.contextWindow)} tokens ({formatInt(a.contextTokens)})
        </dd>
        <dt>This turn</dt>
        <dd>
          {a.toolCalls} tool calls · {a.errors} {a.errors === 1 ? 'error' : 'errors'}
        </dd>
        {a.loop ? (
          <>
            <dt>Started by</dt>
            <dd>
              loop “{a.loop.name}” ({a.loop.tier})
            </dd>
          </>
        ) : null}
        {a.model ? (
          <>
            <dt>Model</dt>
            <dd>{shortModel(a.model)}</dd>
          </>
        ) : null}
      </dl>
      <details className="now-how">
        <summary>How decided</summary>
        <p>{a.evidence}</p>
        <p className="muted">
          Source: {source}
          {source !== 'hooks'
            ? '. Transcripts do not record permission prompts; waits are inferred from silence.'
            : '.'}
        </p>
      </details>
    </div>
  );
}

/** The plant panel's "Now" section: live agents joined to this plant. */
export function LiveNow({ view, plantId }: { view: GardenView; plantId: ID }) {
  const s = useLive();
  useClock(1000);
  if (!s.snapshot) return null;
  const snap = s.snapshot;
  const agents = snap.agents.filter((a) => {
    const anc = anchorFor(a, view);
    return anc.kind === 'plant' && anc.plantId === plantId;
  });
  if (!agents.length) return null;
  const plant = view.plants.find((p) => p.id === plantId);
  return (
    <section className="live-now" aria-label="Now">
      <h4>
        Now <span className="muted">· {agents.length} live</span>
      </h4>
      {agents.slice(0, 4).map((a) => (
        <NowAgent key={a.key} a={a} source={snap.source} />
      ))}
      {agents.length > 4 ? <p className="muted">+{agents.length - 4} more live runs</p> : null}
      {plant && plant.runs > 0 ? (
        <p className="now-replay">
          <a href={latestReplayHref(plantId)}>Replay its latest stored run →</a>
          <span className="muted"> the run in progress appears after the next ingest</span>
        </p>
      ) : null}
    </section>
  );
}
