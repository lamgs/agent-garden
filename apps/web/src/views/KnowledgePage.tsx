/**
 * Knowledge map (`#/knowledge/:bedId`, milestone K): where each run's knowledge comes from.
 * A soil profile of the bed: the topsoil column is what loads in every session (sized by tokens),
 * the seed tray what loads on demand, the compost what never reaches the model. Roots are
 * references (@imports, MEMORY.md links, path mentions); dangling ones are red and dashed.
 * Every block, root, and sprout is drawn by garden/knowledge-draw.ts, the same code as the legend.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  INK,
  LAYER_LABEL,
  STATUS,
  knowledgeColumn,
  knowledgeEdge,
  knowledgeUsage,
  weedKind,
  type ID,
  type KnowledgeFinding,
  type KnowledgeSourceRow,
  type KnowledgeView,
  type WeedKind,
} from '@garden/core';
import { loadKnowledge } from '../data/knowledge';
import type { ViewResult } from '../data/views';
import { formatInt } from '../format';
import { drawWeed } from '../garden/draw';
import {
  blockHeight,
  drawRoot,
  drawSourceBlock,
  drawSprout,
  rootCurve,
  type Pt,
} from '../garden/knowledge-draw';
import type { Pen } from '../garden/pen';
import { SvgPen } from '../garden/svg-pen';
import { Caveat, TickText, ViewMessage } from '../components/ui';
import { LoadingPage, PageShell } from './PageShell';
import '../knowledge.css';

const tok = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `~${n}`);

/** Draw with a Pen into SVG paths (same drawing code as the legend swatches). */
function PenPaths({ draw, opacity }: { draw: (pen: Pen) => void; opacity?: number }) {
  const pen = new SvgPen();
  draw(pen);
  return (
    <g opacity={opacity}>
      {pen.shapes.map((s, i) => (
        <path
          key={i}
          d={s.d}
          fill={s.fill ?? 'none'}
          fillOpacity={s.fillOpacity}
          stroke={s.stroke ?? 'none'}
          strokeWidth={s.strokeWidth}
          strokeOpacity={s.strokeOpacity}
          strokeLinecap={s.cap}
          strokeLinejoin={s.join}
        />
      ))}
    </g>
  );
}

export function KnowledgeRoute({ bedId, days }: { bedId: ID; days: number }) {
  const [result, setResult] = useState<ViewResult<KnowledgeView> | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    void loadKnowledge(bedId, days).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [bedId, days]);
  return <KnowledgePage result={result} />;
}

export function KnowledgePage({ result }: { result: ViewResult<KnowledgeView> | null }) {
  const crumb = 'Knowledge map';
  const [focus, setFocus] = useState<KnowledgeFinding | null>(null);
  if (!result) return <LoadingPage crumb={crumb} />;
  if (result.status !== 'ok')
    return (
      <PageShell crumb={crumb}>
        <ViewMessage
          title={result.status === 'missing' ? result.title : 'Could not load this knowledge map'}
          tone={result.status === 'error' ? 'error' : 'quiet'}
        >
          <p>
            <TickText text={result.message} />
          </p>
        </ViewMessage>
      </PageShell>
    );
  const v = result.data;
  const over = v.budget.alwaysTokens > v.budget.budgetTokens;
  return (
    <PageShell crumb={`Knowledge map · ${v.bed.name}`} table>
      <article className="knowledge-page">
        <header className="page-title">
          <div>
            <div className="kicker">
              Knowledge map · where this bed’s instructions and memory come from
            </div>
            <h2>{v.bed.name}</h2>
            <p className="knowledge-summary">
              <b className={over ? 'k-over' : undefined}>{tok(v.budget.alwaysTokens)} tokens</b>{' '}
              load in every session (budget {formatInt(v.budget.budgetTokens)}) · {v.sources.length}{' '}
              sources · {v.edges.filter((e) => !e.resolved).length} dangling references ·{' '}
              {v.findings.length} findings · {v.sessions.withLoadRecord}/{v.sessions.total} sessions
              carry a load record
            </p>
          </div>
        </header>
        <section className="card knowledge-map-card" aria-label="Provenance map">
          <div className="card-kicker">Soil profile</div>
          <h3 className="card-title">Provenance map</h3>
          <p className="muted">
            Topsoil loads in every session (height ≈ tokens); the seed tray loads when needed (a
            sprout means it loaded in the window); compost never reaches the model. Roots are
            references; red dashed roots point at files that do not exist. Click a finding to see
            its sources. <kbd>L</kbd> opens the legend.
          </p>
          <ProvenanceMap v={v} focus={focus} />
        </section>
        <div className="grid-2-1">
          <section className="card" aria-label="Findings" id="findings">
            <div className="card-kicker">Weeds and bloat</div>
            <h3 className="card-title">Findings ({v.findings.length})</h3>
            <FindingsList v={v} focus={focus} onFocus={setFocus} />
          </section>
          <div className="stack">
            <section className="card" aria-label="Always-loaded budget">
              <div className="card-kicker">Topsoil depth</div>
              <h3 className="card-title">Always-loaded budget</h3>
              <LayerBars v={v} />
              <h4>Over time</h4>
              <BudgetChart v={v} />
              <details className="legend-how">
                <summary>How computed</summary>
                <p>{v.budget.method}</p>
                <p>{v.historyMethod}</p>
              </details>
            </section>
            <section className="card" aria-label="Caveats">
              <div className="card-kicker">Read with care</div>
              <h3 className="card-title">What this can and cannot see</h3>
              {v.caveats.map((c) => (
                <Caveat key={c} text={c} />
              ))}
              {v.memoryDir ? (
                <p className="muted">
                  Memory folder: <code>{v.memoryDir}</code>
                </p>
              ) : null}
            </section>
          </div>
        </div>
        <SourcesTable v={v} />
      </article>
    </PageShell>
  );
}

// ---- provenance map --------------------------------------------------------------------------------

interface Block {
  key: string;
  sourceId: ID | null;
  label: string;
  sub: string;
  tokens: number;
  column: number;
  band: number;
  x: number;
  y: number;
  w: number;
  h: number;
  usage: number | null;
}

const COL_X = [0, 430, 860];
const COL_W = [360, 340, 280];
const TOP = 46;

function layoutMap(v: KnowledgeView) {
  const blocks: Block[] = [];
  const add = (b: Omit<Block, 'x' | 'w'>) => {
    const col = b.column === 0 ? 0 : b.column === 3 ? 2 : 1;
    blocks.push({ ...b, x: COL_X[col]!, w: COL_W[col]! });
  };
  // Topsoil: always-loaded sources in layer order; listings aggregated into one block.
  const order = ['managed', 'user', 'project', 'local', 'rules', 'imports', 'memory'];
  const topsoil = v.sources
    .filter((s) => s.layer && s.layer !== 'listings')
    .sort(
      (a, b) =>
        order.indexOf(a.layer!) - order.indexOf(b.layer!) ||
        a.displayPath.localeCompare(b.displayPath),
    );
  let y = TOP;
  topsoil.forEach((s, i) => {
    const h = blockHeight(s.alwaysTokens);
    add({
      key: s.id,
      sourceId: s.id,
      label: s.displayPath,
      sub: `${LAYER_LABEL[s.layer!]} · ${tok(s.alwaysTokens)}`,
      tokens: s.alwaysTokens,
      column: 0,
      band: i,
      y,
      h,
      usage: knowledgeUsage.level({ loadMode: 'always', used: true }),
    });
    y += h + 2;
  });
  const listings = v.sources.filter((s) => s.layer === 'listings');
  if (listings.length) {
    const t = listings.reduce((n, s) => n + s.alwaysTokens, 0);
    add({
      key: 'listings',
      sourceId: null,
      label: `Skill & agent listings (${listings.length})`,
      sub: `names + descriptions · ${tok(t)}`,
      tokens: t,
      column: 0,
      band: topsoil.length,
      y,
      h: blockHeight(t),
      usage: knowledgeUsage.level({ loadMode: 'always', used: true }),
    });
    y += blockHeight(t) + 2;
  }
  const topH = y;

  // Seed tray: on-demand sources by group.
  const groups: [string, (s: KnowledgeSourceRow) => boolean][] = [
    [
      'Instructions & docs',
      (s) => ['nested_claude_md', 'rule', 'import', 'referenced_doc'].includes(s.kind),
    ],
    ['Memory topics', (s) => s.kind === 'memory_topic'],
    ['Skills', (s) => s.kind === 'skill'],
    ['Agents', (s) => s.kind === 'agent_definition'],
  ];
  const headers: { text: string; x: number; y: number }[] = [];
  y = TOP;
  for (const [title, test] of groups) {
    const list = v.sources
      .filter((s) => !s.layer || s.layer === 'listings')
      .filter((s) => s.loadMode !== 'not_loaded' && test(s));
    if (!list.length) continue;
    headers.push({ text: title, x: COL_X[1]!, y: y + 10 });
    y += 16;
    for (const s of list) {
      const h = Math.max(34, Math.min(44, blockHeight(s.tokens)));
      add({
        key: s.id,
        sourceId: s.id,
        label: s.name ?? s.displayPath,
        sub: `${s.name ? `${s.displayPath} · ` : ''}${tok(s.tokens)}${s.usage.count ? ` · loaded ×${s.usage.count}` : ''}`,
        tokens: s.tokens,
        column: knowledgeColumn.level({
          loadMode: s.loadMode === 'path_scoped' ? 'path_scoped' : 'on_demand',
        }),
        band: 0,
        y,
        h,
        usage: knowledgeUsage.level({ loadMode: s.loadMode, used: s.usage.count > 0 }),
      });
      y += h + 3;
    }
    y += 6;
  }
  const trayH = y;

  // Compost: not-loaded sources, MEMORY.md past its cap, and missing reference targets.
  y = TOP;
  for (const s of v.sources.filter((x) => x.loadMode === 'not_loaded')) {
    add({
      key: s.id,
      sourceId: s.id,
      label: s.displayPath,
      sub: s.loadNote ?? 'not loaded',
      tokens: s.tokens,
      column: 3,
      band: 0,
      y,
      h: Math.max(30, Math.min(48, blockHeight(s.tokens))),
      usage: null,
    });
    y += Math.max(30, Math.min(48, blockHeight(s.tokens))) + 3;
  }
  for (const s of v.sources.filter(
    (x) => x.kind === 'memory_index' && x.tokens > x.alwaysTokens + 1,
  )) {
    const t = s.tokens - s.alwaysTokens;
    add({
      key: `${s.id}:cut`,
      sourceId: s.id,
      label: `${s.displayPath} past the cap`,
      sub: `${tok(t)} tokens the agent never sees`,
      tokens: t,
      column: 3,
      band: 0,
      y,
      h: Math.max(30, Math.min(60, blockHeight(t))),
      usage: null,
    });
    y += Math.max(30, Math.min(60, blockHeight(t))) + 3;
  }
  const missing: { edgeId: ID; target: string; at: Pt }[] = [];
  y += 10;
  for (const e of v.edges.filter((x) => !x.resolved)) {
    missing.push({ edgeId: e.id, target: e.target, at: { x: COL_X[2]! + 10, y: y + 8 } });
    y += 26;
  }
  return { blocks, headers, missing, height: Math.max(topH, trayH, y) + 16 };
}

function ProvenanceMap({ v, focus }: { v: KnowledgeView; focus: KnowledgeFinding | null }) {
  const L = useMemo(() => layoutMap(v), [v]);
  const byKey = new Map(L.blocks.map((b) => [b.key, b]));
  const bySource = new Map<ID, Block>();
  for (const b of L.blocks)
    if (b.sourceId && !bySource.has(b.sourceId)) bySource.set(b.sourceId, b);
  const listings = byKey.get('listings');
  const blockOf = (id: ID) => {
    const b = bySource.get(id);
    const s = v.sources.find((x) => x.id === id);
    if (b) return b;
    return s?.layer === 'listings' ? listings : undefined;
  };
  const focusSources = new Set(focus?.sourceIds ?? []);
  const focusEdges = new Set(focus?.edgeIds ?? []);
  const W = COL_X[2]! + COL_W[2]!;
  const roots: { key: string; pts: Pt[]; level: number; dim: boolean }[] = [];
  for (const e of v.edges) {
    const from = blockOf(e.fromId);
    if (!from) continue;
    // Pointers past the MEMORY.md cap start from the cut-off part in the compost.
    const src = e.beyondCap ? (byKey.get(`${e.fromId}:cut`) ?? from) : from;
    const level = knowledgeEdge.level({
      state: !e.resolved ? 'dangling' : e.beyondCap ? 'beyond_cap' : 'resolved',
    });
    let a: Pt;
    let b: Pt;
    let pts: Pt[];
    if (!e.resolved) {
      const m = L.missing.find((x) => x.edgeId === e.id)!;
      a = { x: src.x + src.w, y: src.y + src.h / 2 };
      b = m.at;
      pts = rootCurve(a, b);
    } else {
      const to = e.toId ? blockOf(e.toId) : undefined;
      if (!to || to === src) continue;
      if (to.x === src.x) {
        // Same column: loop out on the left (topsoil) or right side.
        const side = src.x === 0 ? -1 : 1;
        const ax = side < 0 ? src.x : src.x + src.w;
        a = { x: ax, y: src.y + src.h / 2 };
        b = { x: ax, y: to.y + to.h / 2 };
        const bulge = 18 + Math.min(40, Math.abs(b.y - a.y) / 6);
        pts = Array.from({ length: 21 }, (_, i) => {
          const t = i / 20;
          return { x: ax + side * bulge * Math.sin(Math.PI * t), y: a.y + (b.y - a.y) * t };
        });
      } else {
        const fwd = to.x > src.x;
        a = { x: fwd ? src.x + src.w : src.x, y: src.y + src.h / 2 };
        b = { x: fwd ? to.x : to.x + to.w, y: to.y + to.h / 2 };
        pts = rootCurve(a, b);
      }
    }
    roots.push({
      key: e.id,
      pts,
      level,
      dim: focus !== null && !focusEdges.has(e.id) && !focusSources.has(e.fromId),
    });
  }
  const headerY = 18;
  return (
    <div className="knowledge-map-scroll">
      <svg
        className="knowledge-map"
        viewBox={`-40 0 ${W + 60} ${L.height}`}
        width={W + 60}
        height={L.height}
        role="img"
        aria-label={`Provenance map of ${v.bed.name}: ${L.blocks.length} knowledge blocks, ${v.edges.length} references. The sources table below lists the same data.`}
      >
        {[
          ['Topsoil · always loaded', `${tok(v.budget.alwaysTokens)} tokens per session`],
          ['Seed tray · on demand', 'loaded when read, recalled, invoked, or matched'],
          ['Compost · not loaded', 'on disk, never reaches the model'],
        ].map(([t, s], i) => (
          <g key={t}>
            <text x={COL_X[i]} y={headerY} className="km-col">
              {t}
            </text>
            <text x={COL_X[i]} y={headerY + 15} className="km-col-sub">
              {s}
            </text>
          </g>
        ))}
        {L.headers.map((h) => (
          <text key={h.text} x={h.x} y={h.y} className="km-group">
            {h.text}
          </text>
        ))}
        {L.blocks.map((b) => {
          const hl = b.sourceId !== null && focusSources.has(b.sourceId);
          return (
            <g key={b.key} data-source-id={b.sourceId ?? undefined}>
              <PenPaths
                draw={(pen) => drawSourceBlock(pen, b.x, b.y, b.w, b.h, b.column, b.band, hl)}
              />
              {b.usage !== null && b.column !== 0 ? (
                <PenPaths
                  draw={(pen) => drawSprout(pen, b.x + b.w - 12, b.y + b.h - 4, b.usage!)}
                />
              ) : null}
              <text x={b.x + 8} y={b.h >= 30 ? b.y + 15 : b.y + b.h / 2 + 4} className="km-label">
                {b.label.length > 44 ? `${b.label.slice(0, 43)}…` : b.label}
              </text>
              {b.h >= 30 ? (
                <text x={b.x + 8} y={b.y + 28} className="km-sub">
                  {b.sub.length > 50 ? `${b.sub.slice(0, 49)}…` : b.sub}
                </text>
              ) : (
                <text x={b.x + b.w - 8} y={b.y + b.h / 2 + 4} className="km-sub" textAnchor="end">
                  {tok(b.tokens)}
                </text>
              )}
            </g>
          );
        })}
        {roots.map((r) => (
          <PenPaths
            key={r.key}
            draw={(pen) => drawRoot(pen, r.pts, r.level)}
            opacity={r.dim ? 0.15 : 1}
          />
        ))}
        {L.missing.map((m) => (
          <text
            key={m.edgeId}
            x={m.at.x + 10}
            y={m.at.y + 4}
            className="km-missing"
            fill={STATUS.critical}
          >
            {m.target.length > 34 ? `${m.target.slice(0, 33)}…` : m.target} · missing
          </text>
        ))}
        <line x1={COL_X[0]! - 30} y1={TOP - 4} x2={W} y2={TOP - 4} stroke={INK.hairline} />
      </svg>
    </div>
  );
}

// ---- findings ----------------------------------------------------------------------------------------

const WEEDY = new Set(['dangling_ref', 'orphan_memory', 'duplicate_passage', 'over_cap']);

function WeedIcon({ kind }: { kind: string }) {
  if (!WEEDY.has(kind)) return <span className="k-dot" aria-hidden="true" />;
  const level = weedKind.level({ kind: kind as WeedKind });
  return (
    <svg width="26" height="26" viewBox="-14 -24 28 28" aria-hidden="true" className="k-weed">
      <PenPaths draw={(pen) => drawWeed(pen, 0, 0, level, 1)} />
    </svg>
  );
}

const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

function FindingsList({
  v,
  focus,
  onFocus,
}: {
  v: KnowledgeView;
  focus: KnowledgeFinding | null;
  onFocus: (f: KnowledgeFinding | null) => void;
}) {
  if (!v.findings.length)
    return <p className="muted">No findings: this bed’s knowledge is lean and well mapped.</p>;
  return (
    <ol className="k-findings">
      {v.findings.map((f) => (
        <li key={f.id} className={`k-finding sev-${f.severity}${focus?.id === f.id ? ' on' : ''}`}>
          <button
            type="button"
            className="k-finding-head"
            aria-pressed={focus?.id === f.id}
            onClick={() => onFocus(focus?.id === f.id ? null : f)}
          >
            <WeedIcon kind={f.kind} />
            <span className="k-sev">{SEV_LABEL[f.severity]}</span>
            <span className="k-title">{f.title}</span>
            {f.tokensAtStake ? <span className="k-tok">{tok(f.tokensAtStake)} tok</span> : null}
          </button>
          <p className="k-action">
            <b>Do:</b> <TickText text={f.actionText} />
          </p>
          <details className="legend-how">
            <summary>Evidence</summary>
            <ul>
              {f.evidence.map((e) => (
                <li key={e}>
                  <TickText text={e} />
                </li>
              ))}
            </ul>
            {f.caveat ? <Caveat text={f.caveat} /> : null}
          </details>
        </li>
      ))}
    </ol>
  );
}

// ---- budget ----------------------------------------------------------------------------------------

function LayerBars({ v }: { v: KnowledgeView }) {
  const max = Math.max(1, ...v.budget.layers.map((l) => l.tokens));
  return (
    <table className="k-layers">
      <tbody>
        {v.budget.layers.map((l) => (
          <tr key={l.layer}>
            <th scope="row">{LAYER_LABEL[l.layer]}</th>
            <td>
              <span
                className="k-bar"
                style={{ width: `${Math.max(2, (l.tokens / max) * 100)}%` }}
              />
            </td>
            <td className="num">{tok(l.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BudgetChart({ v }: { v: KnowledgeView }): ReactNode {
  const h = v.history;
  if (h.length < 2)
    return (
      <p className="muted">Not enough history: the project’s instruction files have one version.</p>
    );
  const W = 380;
  const H = 120;
  const t0 = Date.parse(h[0]!.at);
  const t1 = Math.max(Date.parse(h[h.length - 1]!.at), t0 + 1);
  const ymax = Math.max(...h.map((p) => p.tokens), 1) * 1.15;
  const x = (at: string) => 30 + ((Date.parse(at) - t0) / (t1 - t0)) * (W - 40);
  const y = (t: number) => H - 18 - (t / ymax) * (H - 30);
  let d = '';
  h.forEach((p, i) => {
    d += i === 0 ? `M${x(p.at)} ${y(p.tokens)}` : `H${x(p.at)}V${y(p.tokens)}`;
  });
  return (
    <svg
      width={W}
      height={H}
      className="k-chart"
      role="img"
      aria-label={`Project instruction tokens over time: ${h.map((p) => `${p.at.slice(0, 10)} ${tok(p.tokens)}`).join(', ')}`}
    >
      <line x1={30} y1={H - 18} x2={W - 10} y2={H - 18} stroke={INK.hairline} />
      <path d={d} fill="none" stroke={INK.primary} strokeWidth={1.6} />
      {h.map((p) => (
        <g key={p.at + p.provenance}>
          <circle
            cx={x(p.at)}
            cy={y(p.tokens)}
            r={3}
            fill={p.provenance === 'git' ? INK.primary : '#fff'}
            stroke={INK.primary}
          />
          <text x={x(p.at)} y={y(p.tokens) - 7} className="km-sub" textAnchor="middle">
            {tok(p.tokens)}
          </text>
        </g>
      ))}
      <text x={30} y={H - 4} className="km-sub">
        {h[0]!.at.slice(0, 10)}
      </text>
      <text x={W - 10} y={H - 4} className="km-sub" textAnchor="end">
        {h[h.length - 1]!.at.slice(0, 10)}
      </text>
    </svg>
  );
}

// ---- table -------------------------------------------------------------------------------------------

const MODE_LABEL = knowledgeColumn.levels;

function SourcesTable({ v }: { v: KnowledgeView }) {
  return (
    <section className="card" aria-label="Knowledge sources" id="sources">
      <div className="card-kicker">Every source, as a table</div>
      <h3 className="card-title">Knowledge sources ({v.sources.length})</h3>
      <div className="table-scroll">
        <table className="runs-table k-table" tabIndex={-1} aria-label="Knowledge sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Kind</th>
              <th scope="col">Loads</th>
              <th scope="col" className="num">
                ~Tokens
              </th>
              <th scope="col" className="num">
                ~Every session
              </th>
              <th scope="col" className="num">
                Lines
              </th>
              <th scope="col">Used in window</th>
              <th scope="col" className="num">
                Findings
              </th>
            </tr>
          </thead>
          <tbody>
            {v.sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.displayPath}</code>
                  {s.name ? <span className="muted"> · {s.name}</span> : null}
                  {s.loadNote ? <div className="muted k-note">{s.loadNote}</div> : null}
                </td>
                <td>{s.kind.replaceAll('_', ' ')}</td>
                <td>{MODE_LABEL[knowledgeColumn.level({ loadMode: s.loadMode })]}</td>
                <td className="num">{formatInt(s.tokens)}</td>
                <td className="num">{formatInt(s.alwaysTokens)}</td>
                <td className="num">{formatInt(s.lines)}</td>
                <td>
                  {s.loadMode === 'always' && s.usage.count === 0
                    ? 'always (no load record)'
                    : s.usage.count
                      ? `${formatInt(s.usage.count)}× · ${s.usage.kinds.join(', ').replaceAll('_', ' ')}${s.usage.lastAt ? ` · last ${s.usage.lastAt.slice(0, 10)}` : ''}`
                      : 'never'}
                </td>
                <td className="num">{s.findingIds.length || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
