/**
 * Replant (`#/replant?agent=&from=&to=`): the same agent in two beds, drawn in each with its own
 * genotype, so the difference the soil makes is visible before it is read. Numbers come with n,
 * intervals, the separation badge, and the correlation caveat; the soil difference sits between.
 */
import type { ReactNode } from 'react';
import {
  INK,
  type GardenView,
  type PlantSummary,
  type ReplantView,
  type RunRow,
} from '@garden/core';
import {
  formatCi,
  formatDateTime,
  formatPoints,
  formatRatio,
  formatWeight,
  shareText,
  signalName,
  soilChanges,
  verdictSentence,
} from '../compare-format';
import type { ViewResult } from '../data/views';
import {
  formatInt,
  formatLastRun,
  formatShare,
  formatTotalCost,
  formatUsd,
  pct,
  truncate,
} from '../format';
import { plantHref } from '../route';
import { bedToneOf, SoilPlot } from '../components/Specimen';
import {
  BedTag,
  Caveat,
  CiBar,
  OutcomeBadge,
  SeparationBadgeView,
  TickText,
  ViewMessage,
} from '../components/ui';
import { LoadingPage, PageShell } from './PageShell';
import { SoilDiffList } from './SoilDiff';

type Side = ReplantView['from'];

export function ReplantPage({
  result,
}: {
  result: ViewResult<ReplantView> | null;
  garden: GardenView | null;
}) {
  const crumb = 'Replant';
  if (!result) return <LoadingPage crumb={crumb} />;
  if (result.status !== 'ok') {
    return (
      <PageShell crumb={crumb}>
        <ViewMessage
          title={result.status === 'missing' ? result.title : 'Could not load this replant view'}
          tone={result.status === 'error' ? 'error' : 'quiet'}
        >
          <p>
            <TickText text={result.message} />
          </p>
        </ViewMessage>
      </PageShell>
    );
  }
  const v = result.data;
  return (
    <PageShell crumb={`Replant · ${v.agent.name}: ${v.from.bed.name} → ${v.to.bed.name}`} table>
      <ReplantBody v={v} />
    </PageShell>
  );
}

function ReplantBody({ v }: { v: ReplantView }) {
  const both = v.from.plant !== null && v.to.plant !== null;
  const changes = soilChanges(v.harnessDiff, v.harnessChanges);
  return (
    <article className="replant-page">
      <header className="page-title replant-title">
        <div className="kicker">Replant · the same agent in two beds</div>
        <h2>
          {v.agent.name}{' '}
          <span className="replant-route">
            {v.from.bed.name} <span aria-label="to">→</span> {v.to.bed.name}
          </span>
        </h2>
        {v.agent.description ? <p className="specimen-desc">{v.agent.description}</p> : null}
      </header>

      <div className="replant-hero">
        <PlotSide side={v.from} role="from" agentName={v.agent.name} />
        <div className="replant-mid">
          {both ? (
            <div className="verdict">
              <div className="verdict-row">
                <div>
                  <div className="kicker">Success</div>
                  <div className="verdict-big">{formatPoints(v.success.delta)}</div>
                  <div className="verdict-sub">
                    {pctOr(v.from.plant!)} → {pctOr(v.to.plant!)}
                  </div>
                </div>
                <div>
                  <div className="kicker">Cost per run</div>
                  <div className="verdict-big">{formatRatio(v.costRatio)}</div>
                  <div className="verdict-sub">
                    {costOr(v.from.plant!)} → {costOr(v.to.plant!)}
                    {v.from.plant!.costEstimated || v.to.plant!.costEstimated ? (
                      <span className="est">estimated</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <SeparationBadgeView d={v.success} />
              <p className="verdict-text">
                {verdictSentence(v.agent.name, v.to.bed.name, v.success.delta, v.costRatio)}
              </p>
            </div>
          ) : (
            <div className="verdict verdict-empty">
              <div className="kicker">No prediction</div>
              <p>
                {v.agent.name} has never run in {v.to.plant ? v.from.bed.name : v.to.bed.name}, so
                there is nothing to compare yet. Below is the soil it would grow in.
              </p>
            </div>
          )}
          <h3 className="mid-title">What changed in the soil</h3>
          <SoilDiffList items={changes} />
          <Caveat text={v.caveat} />
        </div>
        <PlotSide side={v.to} role="to" agentName={v.agent.name} />
      </div>

      {both ? <SignalCompare v={v} /> : null}

      <section className="recent-pair" aria-label="Recent tasks on each side">
        <RecentTasks side={v.from} />
        <RecentTasks side={v.to} />
      </section>

      <NumbersTable v={v} />
    </article>
  );
}

const pctOr = (p: PlantSummary) => (p.success.value === null ? 'n/a' : pct(p.success.value));
const costOr = (p: PlantSummary) => (p.costPerRunUsd === null ? '?' : formatUsd(p.costPerRunUsd));

function PlotSide({
  side,
  role,
  agentName,
}: {
  side: Side;
  role: 'from' | 'to';
  agentName: string;
}) {
  const p = side.plant;
  const tone = bedToneOf(side.bed);
  return (
    <section className={`plot-side plot-${role}`} aria-label={`${agentName} in ${side.bed.name}`}>
      <div className="plot-head">
        <span className="plot-role">{role === 'from' ? 'From' : 'To'}</span>
        <BedTag bed={side.bed} as="h3" />
      </div>
      <div className="plot-wrap">
        <SoilPlot
          bed={side.bed}
          plants={p ? [{ plant: p, at: 0.5 }] : []}
          width={360}
          height={300}
          k={1.7}
          label={
            p
              ? `${agentName} in ${side.bed.name}, drawn as in the garden`
              : `${side.bed.name}: ${agentName} was never planted here`
          }
        />
        {p ? null : <div className="never-planted">never planted here</div>}
      </div>
      {p ? (
        <div className="plot-stats">
          <div className="plot-rate">
            <span className="plot-big">{pctOr(p)}</span>
            <span className="plot-rate-text">
              success
              <br />
              <span className="muted">
                95% CI {formatCi(p.success)} · <span className="n-label">n={p.success.n}</span>
              </span>
            </span>
          </div>
          <CiBar
            rate={p.success}
            width={320}
            marker={role === 'from' ? 'hollow' : 'filled'}
            tone={tone}
            name={`${agentName} in ${side.bed.name}`}
          />
          <dl className="plot-facts">
            <div>
              <dt>Cost per run</dt>
              <dd>
                {p.costPerRunUsd === null ? 'unknown' : formatUsd(p.costPerRunUsd)}{' '}
                <span className="muted">median</span>
                {p.costEstimated ? <span className="est">estimated</span> : null}
              </dd>
            </div>
            <div>
              <dt>Runs</dt>
              <dd>{formatInt(p.runs)}</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{formatLastRun(p)}</dd>
            </div>
          </dl>
          <a className="quiet-link" href={plantHref(p.id)}>
            Open plant view →
          </a>
        </div>
      ) : (
        <p className="muted plot-stats">
          No runs of {agentName} in {side.bed.name} in this window.
        </p>
      )}
    </section>
  );
}

/** Dumbbell chart: share of runs each heuristic fired in, per side, on one 0–100% axis. */
function SignalCompare({ v }: { v: ReplantView }) {
  const rows = v.signals.filter((s) => s.fromShare !== null || s.toShare !== null);
  const fromTone = bedToneOf(v.from.bed);
  const toTone = bedToneOf(v.to.bed);
  const W = 520;
  const pad = 8;
  const sx = (t: number) => pad + t * (W - pad * 2);
  return (
    <section className="card signals-compare" aria-label="Signals, side by side">
      <div className="card-kicker">The evidence, side by side</div>
      <h3 className="card-title">How often each signal fired</h3>
      <div className="sig-legend" aria-label="Legend">
        <span>
          <Marker hollow tone={fromTone} /> {v.from.bed.name}
        </span>
        <span>
          <Marker tone={toTone} /> {v.to.bed.name}
        </span>
        <span className="muted">share of runs where the signal applied</span>
      </div>
      <div className="dumbbells" role="table" aria-label="Signal share per bed">
        <div className="db-row db-axis" role="row" aria-hidden="true">
          <span />
          <svg width={W} height={16}>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <text key={t} x={sx(t)} y={12} textAnchor="middle" className="axis-text">
                {pct(t)}
              </text>
            ))}
          </svg>
          <span />
        </div>
        {rows.map((s) => {
          const a = s.fromShare;
          const b = s.toShare;
          const tip = `${signalName(s.id)} (weight ${formatWeight(s.weight)}): ${v.from.bed.name} ${shareText(a)}, ${v.to.bed.name} ${shareText(b)}`;
          return (
            <div className="db-row" role="row" key={s.id} data-tip={tip}>
              <span className="db-label" role="rowheader">
                {signalName(s.id)} <span className="muted">{formatWeight(s.weight)}</span>
              </span>
              <svg width={W} height={22} role="cell" aria-label={tip}>
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <line key={t} x1={sx(t)} x2={sx(t)} y1={2} y2={20} stroke={INK.hairline} />
                ))}
                {a !== null && b !== null ? (
                  <line x1={sx(a)} x2={sx(b)} y1={11} y2={11} stroke={INK.muted} strokeWidth={2} />
                ) : null}
                {a !== null ? (
                  <circle
                    cx={sx(a)}
                    cy={11}
                    r={5}
                    fill="var(--paper)"
                    stroke={fromTone}
                    strokeWidth={2}
                  />
                ) : null}
                {b !== null ? (
                  <circle
                    cx={sx(b)}
                    cy={11}
                    r={5}
                    fill={toTone}
                    stroke="var(--paper)"
                    strokeWidth={1.5}
                  />
                ) : null}
              </svg>
              <span className="db-values" role="cell">
                {shareText(a)} → {shareText(b)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Marker({ hollow = false, tone }: { hollow?: boolean; tone: string }) {
  return (
    <svg width={12} height={12} aria-hidden="true" className="marker">
      <circle
        cx={6}
        cy={6}
        r={4.5}
        fill={hollow ? 'var(--paper)' : tone}
        stroke={hollow ? tone : 'var(--paper)'}
        strokeWidth={hollow ? 2 : 1}
      />
    </svg>
  );
}

function RecentTasks({ side }: { side: Side }) {
  return (
    <section className="card recent" aria-label={`Recent tasks in ${side.bed.name}`}>
      <div className="card-kicker">Recent tasks · judge the task mix</div>
      <BedTag bed={side.bed} as="h3" />
      {side.recent.length === 0 ? (
        <p className="muted">No runs in this window.</p>
      ) : (
        <table className="data-table recent-table">
          <tbody>
            {side.recent.slice(0, 5).map((r: RunRow) => (
              <tr key={r.runId}>
                <td className="nowrap muted">{formatDateTime(r.startedAt).slice(0, 10)}</td>
                <td className="task-cell" title={r.taskPreview}>
                  {truncate(r.taskPreview, 70)}
                </td>
                <td className="nowrap">
                  <OutcomeBadge label={r.outcome.label} />
                  {r.outcome.source === 'manual' ? (
                    <span className="manual-chip">manual</span>
                  ) : null}
                </td>
                <td className="num nowrap">
                  {r.costUsd === null ? '?' : formatUsd(r.costUsd)}
                  {r.costEstimated ? <span className="est">est.</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function NumbersTable({ v }: { v: ReplantView }) {
  const a = v.from.plant;
  const b = v.to.plant;
  const cell = (p: PlantSummary | null, f: (p: PlantSummary) => ReactNode) =>
    p ? f(p) : <span className="muted">never planted</span>;
  const rows: [string, ReactNode, ReactNode][] = [
    [
      'Success',
      cell(a, (p) => `${pctOr(p)} (95% CI ${formatCi(p.success)}, n=${p.success.n})`),
      cell(b, (p) => `${pctOr(p)} (95% CI ${formatCi(p.success)}, n=${p.success.n})`),
    ],
    [
      'Unknown / manual',
      cell(a, (p) => `${p.success.nUnknown} / ${p.success.nManual}`),
      cell(b, (p) => `${p.success.nUnknown} / ${p.success.nManual}`),
    ],
    ['Runs', cell(a, (p) => formatInt(p.runs)), cell(b, (p) => formatInt(p.runs))],
    [
      'Failure share, 14 d',
      cell(a, (p) => formatShare(p.recentFailureShare)),
      cell(b, (p) => formatShare(p.recentFailureShare)),
    ],
    [
      'Cost per run (median)',
      cell(a, (p) => `${costOr(p)}${p.costEstimated ? ' (estimated)' : ''}`),
      cell(b, (p) => `${costOr(p)}${p.costEstimated ? ' (estimated)' : ''}`),
    ],
    ['Total cost', cell(a, formatTotalCost), cell(b, formatTotalCost)],
    ['Last run', cell(a, formatLastRun), cell(b, formatLastRun)],
  ];
  return (
    <section className="card numbers" id="numbers" aria-label="Replant numbers as a table">
      <div className="card-kicker">Same numbers, as a table</div>
      <h3 className="card-title">Numbers</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">{v.from.bed.name}</th>
            <th scope="col">{v.to.bed.name}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, x, y]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{x}</td>
              <td>{y}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Difference</th>
            <td colSpan={2}>
              {formatPoints(v.success.delta)} success ·{' '}
              {v.success.delta === null
                ? 'not comparable'
                : v.success.separated
                  ? 'separated (intervals don’t overlap)'
                  : 'within noise (intervals overlap)'}{' '}
              · cost ratio {formatRatio(v.costRatio)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
