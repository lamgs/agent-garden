/**
 * Small shared pieces for the M4 pages: hover tips on marks, outcome badges, the outcome-mix bar,
 * Wilson-interval bars, the separated / within-noise badge, harness cards, and load states.
 * Status colors appear only for outcome state, always next to a glyph and a text label.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  INK,
  OUTCOME_LABELS,
  STATUS,
  type BedSummary,
  type HarnessSummary,
  type OutcomeLabel,
  type Rate,
  type RateDelta,
} from '@garden/core';
import { formatCi, separationBadge } from '../compare-format';
import { bedLabel, formatBytes, formatInt, pct, shortModel } from '../format';
import { bedToneOf } from './Specimen';

export const OUTCOME_COLOR: Record<OutcomeLabel, string> = {
  success: STATUS.good,
  partial: STATUS.warning,
  failure: STATUS.critical,
  unknown: INK.muted,
};
export const OUTCOME_GLYPH: Record<OutcomeLabel, string> = {
  success: '✓',
  partial: '◐',
  failure: '✕',
  unknown: '?',
};

/**
 * One tooltip for every element with `data-tip` (marks in the small charts, badges). Follows the
 * pointer; keyboard focus shows it too. Text only, no HTML.
 */
export function HoverTipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const find = (t: EventTarget | null) =>
      t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null;
    const over = (e: PointerEvent) => {
      const el = find(e.target);
      setTip(el ? { text: el.dataset.tip ?? '', x: e.clientX, y: e.clientY } : null);
    };
    const focus = (e: FocusEvent) => {
      const el = find(e.target);
      if (!el) return setTip(null);
      const r = el.getBoundingClientRect();
      setTip({ text: el.dataset.tip ?? '', x: r.left + r.width / 2, y: r.bottom });
    };
    const hide = () => setTip(null);
    document.addEventListener('pointermove', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('hashchange', hide);
    return () => {
      document.removeEventListener('pointermove', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('hashchange', hide);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = tip.x + 14;
    let top = tip.y + 16;
    if (left + w > window.innerWidth - 8) left = tip.x - w - 14;
    if (top + h > window.innerHeight - 8) top = tip.y - h - 12;
    el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }, [tip]);
  return (
    <div ref={ref} className={`hover-tip${tip?.text ? ' show' : ''}`} role="tooltip">
      {tip?.text}
    </div>
  );
}

export function OutcomeDot({ label }: { label: OutcomeLabel }) {
  return (
    <span className={`outcome-dot outcome-${label}`} aria-hidden="true">
      {OUTCOME_GLYPH[label]}
    </span>
  );
}

export function OutcomeBadge({ label }: { label: OutcomeLabel }) {
  return (
    <span className="outcome-badge">
      <OutcomeDot label={label} />
      {label}
    </span>
  );
}

/** Outcome mix as a thin stacked bar (2px gaps), each segment labeled with its count below. */
export function OutcomeMixBar({ mix }: { mix: Record<OutcomeLabel, number> }) {
  const total = OUTCOME_LABELS.reduce((s, l) => s + mix[l], 0);
  const W = 520;
  const GAP = 2;
  const present = OUTCOME_LABELS.filter((l) => mix[l] > 0);
  const usable = W - GAP * Math.max(0, present.length - 1);
  let x = 0;
  const segs = present.map((l) => {
    const w = total ? (mix[l] / total) * usable : 0;
    const s = { l, x, w };
    x += w + GAP;
    return s;
  });
  return (
    <figure className="mix">
      <svg
        viewBox={`0 0 ${W} 10`}
        preserveAspectRatio="none"
        className="mix-bar"
        role="img"
        aria-label={`Outcome mix: ${OUTCOME_LABELS.map((l) => `${l} ${mix[l]}`).join(', ')}`}
      >
        {total === 0 ? <rect x={0} y={0} width={W} height={10} rx={3} fill={INK.hairline} /> : null}
        {segs.map((s) => (
          <rect
            key={s.l}
            x={s.x}
            y={0}
            width={Math.max(0.5, s.w)}
            height={10}
            rx={2}
            fill={OUTCOME_COLOR[s.l]}
            data-tip={`${s.l}: ${mix[s.l]} of ${total} runs (${pct(mix[s.l] / total)})`}
          />
        ))}
      </svg>
      <figcaption className="mix-legend">
        {OUTCOME_LABELS.map((l) => (
          <span key={l} className={mix[l] === 0 ? 'zero' : undefined}>
            <OutcomeDot label={l} /> {l} <b>{formatInt(mix[l])}</b>
            {total > 0 ? <span className="muted"> ({pct(mix[l] / total)})</span> : null}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/**
 * A rate on a 0–100% track with its 95% Wilson interval as a band. `marker` 'hollow' / 'filled'
 * distinguishes two sides without color.
 */
export function CiBar({
  rate,
  width = 220,
  marker = 'filled',
  name,
  tone = INK.primary,
}: {
  rate: Rate;
  width?: number;
  marker?: 'filled' | 'hollow';
  name?: string;
  tone?: string;
}) {
  const H = 18;
  const pad = 5;
  const sx = (v: number) => pad + v * (width - pad * 2);
  const tip =
    rate.value === null
      ? `${name ? `${name}: ` : ''}no labeled runs`
      : `${name ? `${name}: ` : ''}${pct(rate.value)} success, 95% CI ${formatCi(rate)}, n=${rate.n}`;
  return (
    <svg
      className="ci-bar"
      width={width}
      height={H}
      viewBox={`0 0 ${width} ${H}`}
      role="img"
      aria-label={tip}
    >
      <line x1={sx(0)} x2={sx(1)} y1={H / 2} y2={H / 2} stroke={INK.hairline} strokeWidth={2} />
      {[0, 0.5, 1].map((t) => (
        <line key={t} x1={sx(t)} x2={sx(t)} y1={H / 2 - 4} y2={H / 2 + 4} stroke={INK.hairline} />
      ))}
      <g data-tip={tip}>
        <rect x={0} y={0} width={width} height={H} fill="transparent" />
        {rate.ci95 ? (
          <rect
            x={sx(rate.ci95[0])}
            y={H / 2 - 3}
            width={Math.max(2, sx(rate.ci95[1]) - sx(rate.ci95[0]))}
            height={6}
            rx={3}
            fill={tone}
            opacity={0.28}
          />
        ) : null}
        {rate.value !== null ? (
          <circle
            cx={sx(rate.value)}
            cy={H / 2}
            r={4.5}
            fill={marker === 'filled' ? tone : 'var(--paper)'}
            stroke={tone}
            strokeWidth={1.8}
          />
        ) : null}
      </g>
    </svg>
  );
}

export function RateLine({ rate }: { rate: Rate }) {
  if (rate.value === null) {
    return <span className="rate-line">no labeled runs (n=0, {rate.nUnknown} unknown)</span>;
  }
  return (
    <span className="rate-line">
      <b>{pct(rate.value)}</b> <span className="muted">95% CI {formatCi(rate)} ·</span>{' '}
      <span className="n-label">n={rate.n}</span>
      {rate.nManual ? <span className="muted"> · {rate.nManual} manual</span> : null}
    </span>
  );
}

export function SeparationBadgeView({ d }: { d: RateDelta }) {
  const b = separationBadge(d);
  return (
    <span className={`sep-badge sep-${b.kind}`} data-tip={b.title} tabIndex={0}>
      {b.kind === 'separated' ? '◆ ' : b.kind === 'noise' ? '≈ ' : ''}
      {b.label}
      {b.kind === 'separated' ? <span className="sep-note">intervals don’t overlap</span> : null}
      {b.kind === 'noise' ? <span className="sep-note">intervals overlap</span> : null}
    </span>
  );
}

export function Caveat({ text }: { text: string }) {
  return (
    <p className="caveat" role="note">
      <span className="caveat-mark" aria-hidden="true">
        ※
      </span>{' '}
      {text}
    </p>
  );
}

export function BedTag({ bed, as = 'span' }: { bed: BedSummary; as?: 'span' | 'h3' }) {
  const Tag = as;
  return (
    <Tag className="bed-tag">
      <span className="bed-chip" style={{ background: bedToneOf(bed) }} aria-hidden="true" />
      {bedLabel(bed)}
    </Tag>
  );
}

/** Plain text where `backticked` spans render as code (for command names in messages). */
export function TickText({ text }: { text: string }) {
  return (
    <>{text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>
  );
}

export function LevelChip({ children }: { children: ReactNode }) {
  return <span className="level-chip">{children}</span>;
}

export function Card({
  title,
  kicker,
  children,
  className,
  id,
}: {
  title: string;
  kicker?: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`} id={id} aria-label={title}>
      {kicker ? <div className="card-kicker">{kicker}</div> : null}
      <h3 className="card-title">{title}</h3>
      {children}
    </section>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const PROVENANCE: Record<HarnessSummary['provenance'], string> = {
  git: 'git history',
  observed: 'observed in transcripts',
  snapshot: 'config snapshot',
};

export function harnessRows(h: HarnessSummary): [string, ReactNode][] {
  return [
    ['Model', shortModel(h.model)],
    ['Effort', h.effort ?? 'default'],
    ['Permission mode', h.permissionMode ?? 'default'],
    ['Instructions', formatBytes(h.instructionBytes)],
    [
      'Tools',
      h.toolCount ? (
        <span data-tip={h.tools.join(', ')}>{h.toolCount}</span>
      ) : (
        <span className="muted">none listed</span>
      ),
    ],
    [
      'MCP servers',
      h.mcpServers.length ? `${h.mcpServers.length}: ${h.mcpServers.join(', ')}` : 'none',
    ],
    ['Skills', String(h.skillCount)],
    ['Hooks', String(h.hookCount)],
    [
      'Version',
      <>
        since {h.validFrom.slice(0, 10)} · {PROVENANCE[h.provenance]}
        {h.commitMessage ? <span className="commit">“{h.commitMessage}”</span> : null}
      </>,
    ],
  ];
}

export function HarnessFacts({ harness }: { harness: HarnessSummary | null }) {
  if (!harness) return <p className="muted">No harness version recorded for this bed.</p>;
  return (
    <>
      <Facts rows={harnessRows(harness)} />
      {harness.changes.length ? (
        <div className="changes">
          <div className="changes-title">Changed from the previous version</div>
          <ul>
            {harness.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function ViewMessage({
  title,
  children,
  tone = 'quiet',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'quiet' | 'error';
}) {
  return (
    <div
      className={`view-message view-message-${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <h2>{title}</h2>
      {children}
      <p>
        <a href="#/">← Back to the garden</a>
      </p>
    </div>
  );
}
