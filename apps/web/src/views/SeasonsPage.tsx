/**
 * Seasons (`#/seasons/:bedId`): a bed's harness history as seasons on a time axis, one small
 * multiple per agent with its success rate and 95% Wilson interval per season, the change in
 * rate at each boundary (separated / within noise), what changed in the soil, and a date
 * scrubber that opens the garden as of that date. Correlation, not causation: the page says so.
 */
import { useState } from 'react';
import {
  INK,
  MIN_RUNS_FOR_BLOOM,
  PAPER,
  type GardenView,
  type RateDelta,
  type SeasonStat,
  type SeasonsView,
} from '@garden/core';
import {
  formatCi,
  formatDateTime,
  formatPoints,
  separationBadge,
  soilChanges,
} from '../compare-format';
import type { DataSource } from '../data/load';
import type { ViewResult } from '../data/views';
import { ESTIMATE_NOTE, formatInt, formatUsd, pct, truncate } from '../format';
import { gardenAsOfHref, navigate, plantHref, seasonsHref } from '../route';
import {
  dayCount,
  dayToAsOf,
  defaultScrubDay,
  layoutLabels,
  primaryChain,
  PROVENANCE_LABEL,
  rowSpans,
  seasonIndexAt,
  seriesKey,
  seriesLabel,
  spanAt,
  type SeasonSpan,
  type Series,
} from '../seasons-format';
import { BedTag, Caveat, TickText, ViewMessage } from '../components/ui';
import { LoadingPage, PageShell } from './PageShell';
import { SoilDiffList } from './SoilDiff';
import './seasons.css';

/** Plot geometry shared by the band, the scrubber, and every row, so they line up. */
const PLOT_W = 880;
const PAD = 6;
const GUTTER = 36;
const ROW_H = 84;
const ROW_TOP = 8;
const ROW_PLOT_H = ROW_H - ROW_TOP - 10;

function xScale(v: SeasonsView) {
  const w0 = Date.parse(v.window.from);
  const w1 = Date.parse(v.window.to);
  return (t: number) => PAD + ((t - w0) / Math.max(1, w1 - w0)) * (PLOT_W - PAD * 2);
}
const yOf = (r: number) => ROW_TOP + (1 - r) * ROW_PLOT_H;
const tint = (i: number) =>
  i % 2 ? { fill: INK.hairline, opacity: 0.5 } : { fill: PAPER, opacity: 0 };

export const AS_OF_NEEDS_SERVER =
  'A garden as of a past date is computed by the local server; run `pnpm demo` or `garden serve`.';

export function SeasonsPage({
  result,
  garden,
}: {
  result: ViewResult<SeasonsView> | null;
  garden: GardenView | null;
}) {
  const crumb = 'Seasons';
  if (!result) return <LoadingPage crumb={crumb} />;
  if (result.status !== 'ok') {
    return (
      <PageShell crumb={crumb}>
        <ViewMessage
          title={result.status === 'missing' ? result.title : 'Could not load these seasons'}
          tone={result.status === 'error' ? 'error' : 'quiet'}
        >
          <p>
            <TickText text={result.message} />
          </p>
        </ViewMessage>
      </PageShell>
    );
  }
  return (
    <Seasons key={result.data.familyId} v={result.data} source={result.source} garden={garden} />
  );
}

function Seasons({
  v,
  source,
  garden,
}: {
  v: SeasonsView;
  source: DataSource;
  garden: GardenView | null;
}) {
  const [day, setDay] = useState(() => defaultScrubDay(v));
  const asOf = dayToAsOf(v, day);
  const scrubT = Date.parse(asOf);
  const chain = primaryChain(v);
  const lead = v.series[0];
  return (
    <PageShell crumb={`Seasons · ${v.bed.name}`} table>
      <article className="seasons-page">
        <header className="page-title compare-title">
          <div>
            <div className="kicker">Seasons · harness versions over time</div>
            <h2>{v.bed.name}</h2>
            <BedTag bed={v.bed} />
          </div>
          {garden ? (
            <label className="bed-switcher">
              <span>Bed</span>
              <select value={v.familyId} onChange={(e) => navigate(seasonsHref(e.target.value))}>
                {[...garden.beds]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </header>
        <Caveat text={v.caveat} />

        <section className="card season-timeline" aria-label="Harness seasons">
          <div className="card-kicker">
            {lead ? `${lead.agentName} harness · ` : ''}
            {chain.length} {chain.length === 1 ? 'season' : 'seasons'} in{' '}
            {v.window.from.slice(0, 10)} → {v.window.to.slice(0, 10)}
          </div>
          <h3 className="card-title">Harness seasons</h3>
          <div className="season-grid">
            <div className="row-label muted">Season band</div>
            <SeasonBand v={v} scrubT={scrubT} />
            <label className="row-label scrub-label" htmlFor="season-scrub">
              Scrub to date
            </label>
            <div>
              <input
                id="season-scrub"
                className="season-scrub"
                type="range"
                min={0}
                max={dayCount(v) - 1}
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                style={{ width: PLOT_W }}
                aria-valuetext={asOf.slice(0, 10)}
              />
              <ScrubReadout v={v} asOf={asOf} source={source} />
            </div>
          </div>
        </section>

        <Boundaries v={v} />

        <section className="card season-rows" aria-label="Outcomes per season" id="rows">
          <div className="card-kicker">Small multiples · one row per agent</div>
          <h3 className="card-title">Success per season, with 95% Wilson intervals</h3>
          <p className="muted season-note">
            Line = success rate in that season; shaded band = 95% Wilson interval; hollow marker =
            fewer than {MIN_RUNS_FOR_BLOOM} labeled runs. Under each boundary: the change from the
            previous season and whether the intervals separate. Loop-triggered runs have their own
            row. Dashed line = the scrubbed date.
          </p>
          <div className="season-grid">
            {v.series.map((s) => (
              <SeriesRow key={seriesKey(s)} v={v} s={s} scrubT={scrubT} />
            ))}
          </div>
        </section>

        <NumbersTable v={v} />
        <HowComputed v={v} />
      </article>
    </PageShell>
  );
}

function SeasonBand({ v, scrubT }: { v: SeasonsView; scrubT: number }) {
  const x = xScale(v);
  const lead = v.series[0];
  const spans = lead ? rowSpans(v, lead) : [];
  const H = 46;
  return (
    <svg
      className="season-band"
      width={PLOT_W + GUTTER}
      height={H}
      viewBox={`0 0 ${PLOT_W + GUTTER} ${H}`}
      role="img"
      aria-label={`Season band: ${spans.map((s, i) => `season ${i + 1} ${s.season.title} from ${s.season.from.slice(0, 10)}`).join('; ')}`}
    >
      {spans.map((s) => {
        const x0 = x(s.t0);
        const w = Math.max(1, x(s.t1) - x0);
        const t = tint(s.index);
        const tip = `Season ${s.index + 1}: ${s.season.title} · ${s.season.from.slice(0, 10)} → ${s.season.to ? s.season.to.slice(0, 10) : 'now'} · ${PROVENANCE_LABEL[s.season.provenance]}`;
        return (
          <g key={s.season.harnessVersionId} data-tip={tip}>
            <rect x={x0} y={0} width={w} height={H} fill={t.fill} fillOpacity={t.opacity} />
            <rect x={x0} y={0} width={w} height={H} fill="none" stroke={INK.hairline} />
            <circle cx={x0 + 12} cy={14} r={8} fill={PAPER} stroke={INK.secondary} />
            <text x={x0 + 12} y={17.5} textAnchor="middle" fontSize={10.5} fill={INK.primary}>
              {s.index + 1}
            </text>
            {w > 40 ? (
              <text x={x0 + 25} y={18} fontSize={12.5} fontWeight={600} fill={INK.primary}>
                {truncate(s.season.title, Math.floor((w - 30) / 6.8))}
              </text>
            ) : null}
            {w > 40 ? (
              <text x={x0 + 8} y={37} fontSize={11} fill={INK.secondary}>
                {truncate(
                  `${s.season.from.slice(0, 10)} · ${s.season.provenance}`,
                  Math.floor((w - 12) / 6),
                )}
              </text>
            ) : null}
          </g>
        );
      })}
      <ScrubLine x={x(scrubT)} h={H} />
    </svg>
  );
}

function ScrubLine({ x, h }: { x: number; h: number }) {
  return (
    <line
      className="scrub-line"
      x1={x}
      x2={x}
      y1={0}
      y2={h}
      stroke={INK.primary}
      strokeWidth={1.5}
      strokeDasharray="4 3"
    />
  );
}

function ScrubReadout({ v, asOf, source }: { v: SeasonsView; asOf: string; source: DataSource }) {
  const chain = primaryChain(v);
  const idx = seasonIndexAt(v, asOf);
  const season = idx >= 0 ? chain[idx] : undefined;
  const disabled = source !== 'api';
  return (
    <div className="scrub-readout">
      <span>
        <b className="scrub-date">{asOf.slice(0, 10)}</b>{' '}
        <span className="muted">
          {season
            ? `· season ${idx + 1} of ${chain.length}: “${season.title}”`
            : '· before the first recorded season'}
        </span>
      </span>
      <button
        type="button"
        className="primary"
        disabled={disabled}
        onClick={() => navigate(gardenAsOfHref(asOf))}
      >
        View garden as of {asOf.slice(0, 10)} →
      </button>
      {disabled ? (
        <span className="muted">
          <TickText text={AS_OF_NEEDS_SERVER} />
        </span>
      ) : null}
    </div>
  );
}

function DeltaBadge({ d }: { d: RateDelta }) {
  const b = separationBadge(d);
  return (
    <span className={`sep-badge sep-${b.kind} season-sep`} data-tip={b.title} tabIndex={0}>
      {b.kind === 'separated' ? '◆ ' : b.kind === 'noise' ? '≈ ' : ''}
      {b.label}
    </span>
  );
}

function Boundaries({ v }: { v: SeasonsView }) {
  const chain = primaryChain(v);
  const lead = v.series[0];
  const boundaries = chain.slice(1);
  return (
    <section className="card season-boundaries" aria-label="What changed at each boundary">
      <div className="card-kicker">Boundaries</div>
      <h3 className="card-title">What changed in the soil</h3>
      {boundaries.length === 0 ? (
        <p className="muted">
          One harness for the whole window: no boundary to compare across. Seasons appear when the
          harness changes (a commit to CLAUDE.md, settings, hooks, MCP, or an observed model or
          effort change).
        </p>
      ) : (
        <ol className="boundary-list">
          {boundaries.map((s, i) => {
            const stat = lead?.perSeason.find((p) => p.harnessVersionId === s.harnessVersionId);
            const prev = lead?.perSeason.find(
              (p) => p.harnessVersionId === chain[i]!.harnessVersionId,
            );
            return (
              <li key={s.harnessVersionId} className="boundary">
                <div className="boundary-head">
                  <span className="boundary-num" aria-hidden="true">
                    {i + 1} → {i + 2}
                  </span>
                  <div>
                    <div className="boundary-title">{s.title}</div>
                    <div className="muted">
                      {formatDateTime(s.from)} · {PROVENANCE_LABEL[s.provenance]}
                    </div>
                  </div>
                </div>
                <SoilDiffList items={soilChanges(null, s.diffSummary)} />
                {lead && stat && prev ? (
                  <p className="boundary-outcome">
                    <span className="muted">{seriesLabel(lead)}:</span> <b>{rateText(prev)}</b> →{' '}
                    <b>{rateText(stat)}</b>{' '}
                    <span className="delta">{formatPoints(stat.vsPrevious?.delta ?? null)}</span>{' '}
                    {stat.vsPrevious ? <DeltaBadge d={stat.vsPrevious} /> : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const rateText = (p: SeasonStat) => (p.success.value === null ? 'n/a' : pct(p.success.value));

function statTip(label: string, s: SeasonSpan): string {
  const p = s.stat!;
  const r = p.success;
  const head = `${label} · season ${s.index + 1}: ${s.season.title}`;
  if (r.value === null) return `${head} — ${p.runs} runs, no labeled runs (${r.nUnknown} unknown).`;
  const cost =
    p.costPerRunUsd === null
      ? 'cost unknown'
      : `${formatUsd(p.costPerRunUsd)} median per run${p.costEstimated ? ` (${ESTIMATE_NOTE})` : ''}`;
  return `${head} — ${pct(r.value)} success, 95% CI ${formatCi(r)}, n=${r.n} labeled (${r.nUnknown} unknown, ${r.nManual} manual), ${p.runs} runs, ${cost}.`;
}

const LABEL_BOX = 128;

function SeriesRow({ v, s, scrubT }: { v: SeasonsView; s: Series; scrubT: number }) {
  const x = xScale(v);
  const spans = rowSpans(v, s);
  const label = seriesLabel(s);
  const total = s.perSeason.reduce((n, p) => n + p.runs, 0);
  const lefts = layoutLabels(
    spans.map((sp) => (x(sp.t0) + x(sp.t1)) / 2 - LABEL_BOX / 2),
    spans.map(() => LABEL_BOX),
    PLOT_W,
  );
  const current = spanAt(spans, scrubT);
  return (
    <>
      <div className="row-label">
        {s.plantId ? (
          <a href={plantHref(s.plantId)} className="row-agent">
            {s.agentName}
          </a>
        ) : (
          <span className="row-agent">{s.agentName}</span>
        )}
        {s.loop ? (
          <span className="loop-tag" data-tip={`Runs triggered by the loop “${s.loop.name}”`}>
            loop · {truncate(s.loop.name, 22)}
          </span>
        ) : null}
        <span className="muted">{formatInt(total)} runs</span>
      </div>
      <div className="row-body">
        <svg
          className="season-row"
          width={PLOT_W + GUTTER}
          height={ROW_H}
          viewBox={`0 0 ${PLOT_W + GUTTER} ${ROW_H}`}
          role="img"
          aria-label={`${label}: ${spans.map((sp) => (sp.stat ? statTip(label, sp) : '')).join(' ')}`}
        >
          {spans.map((sp) => {
            const t = tint(sp.index);
            return (
              <rect
                key={`bg${sp.index}`}
                x={x(sp.t0)}
                y={0}
                width={Math.max(1, x(sp.t1) - x(sp.t0))}
                height={ROW_H}
                fill={t.fill}
                fillOpacity={t.opacity}
              />
            );
          })}
          {[0, 0.5, 1].map((g) => (
            <g key={g}>
              <line
                x1={PAD}
                x2={PLOT_W - PAD}
                y1={yOf(g)}
                y2={yOf(g)}
                stroke={INK.hairline}
                strokeWidth={1}
              />
              <text x={PLOT_W + 4} y={yOf(g) + 3.5} fontSize={10} fill={INK.muted}>
                {g === 0 ? '0' : `${g * 100}%`}
              </text>
            </g>
          ))}
          {spans.slice(1).map((sp) => (
            <line
              key={`b${sp.index}`}
              x1={x(sp.t0)}
              x2={x(sp.t0)}
              y1={0}
              y2={ROW_H}
              stroke={INK.secondary}
              strokeWidth={1}
            />
          ))}
          {spans.map((sp) => {
            const r = sp.stat?.success;
            const x0 = x(sp.t0);
            const x1 = x(sp.t1);
            const cx = (x0 + x1) / 2;
            if (!r || r.value === null)
              return (
                <g key={`m${sp.index}`} data-tip={sp.stat ? statTip(label, sp) : ''}>
                  <rect
                    x={x0}
                    y={0}
                    width={Math.max(1, x1 - x0)}
                    height={ROW_H}
                    fill="transparent"
                  />
                  {x1 - x0 > 50 ? (
                    <text
                      x={cx}
                      y={yOf(0.5) - 4}
                      textAnchor="middle"
                      fontSize={11}
                      fontStyle="italic"
                      fill={INK.muted}
                    >
                      {sp.stat?.runs ? 'no labeled runs' : 'no runs'}
                    </text>
                  ) : null}
                </g>
              );
            const hollow = r.n < MIN_RUNS_FOR_BLOOM;
            return (
              <g key={`m${sp.index}`} data-tip={statTip(label, sp)}>
                <rect x={x0} y={0} width={Math.max(1, x1 - x0)} height={ROW_H} fill="transparent" />
                {r.ci95 ? (
                  <rect
                    x={x0 + 1}
                    y={yOf(r.ci95[1])}
                    width={Math.max(1, x1 - x0 - 2)}
                    height={Math.max(1, yOf(r.ci95[0]) - yOf(r.ci95[1]))}
                    fill={INK.primary}
                    fillOpacity={0.14}
                  />
                ) : null}
                <line
                  x1={x0 + 1}
                  x2={x1 - 1}
                  y1={yOf(r.value)}
                  y2={yOf(r.value)}
                  stroke={INK.primary}
                  strokeWidth={2}
                />
                <circle
                  cx={cx}
                  cy={yOf(r.value)}
                  r={4.5}
                  fill={hollow ? PAPER : INK.primary}
                  stroke={hollow ? INK.primary : PAPER}
                  strokeWidth={hollow ? 1.6 : 2}
                />
              </g>
            );
          })}
          <ScrubLine x={x(scrubT)} h={ROW_H} />
        </svg>
        <div className="row-stats" style={{ width: PLOT_W }}>
          {spans.map((sp, i) => {
            const p = sp.stat!;
            return (
              <div
                key={sp.index}
                className={`row-stat${current === sp ? ' at-scrub' : ''}`}
                style={{ left: lefts[i], width: LABEL_BOX }}
                data-tip={statTip(label, sp)}
              >
                <div>
                  <b className="row-rate">{rateText(p)}</b>{' '}
                  <span className="n-label">n={p.success.n}</span>
                  {p.success.value !== null ? (
                    <span className="muted"> {formatCi(p.success)}</span>
                  ) : null}
                </div>
                {p.vsPrevious ? (
                  <div className="row-delta">
                    <span>{formatPoints(p.vsPrevious.delta).replace(' points', ' pts')}</span>{' '}
                    <DeltaBadge d={p.vsPrevious} />
                  </div>
                ) : (
                  <div className="muted row-delta">first season</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function NumbersTable({ v }: { v: SeasonsView }) {
  const byId = new Map(v.seasons.map((s) => [s.harnessVersionId, s]));
  return (
    <section className="card season-numbers" id="numbers" aria-label="Season numbers">
      <div className="card-kicker">Table view</div>
      <h3 className="card-title">Every number on this page</h3>
      <div className="table-scroll">
        <table className="data-table" aria-label="Seasons table" tabIndex={-1}>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Season</th>
              <th scope="col">From → to</th>
              <th scope="col" className="num">
                Runs
              </th>
              <th scope="col">Success (95% CI)</th>
              <th scope="col" className="num">
                Labeled · unknown · manual
              </th>
              <th scope="col" className="num">
                Median cost / run
              </th>
              <th scope="col" className="num">
                Δ vs previous
              </th>
              <th scope="col">Separation</th>
            </tr>
          </thead>
          <tbody>
            {v.series.flatMap((s) =>
              s.perSeason.map((p, i) => {
                const season = byId.get(p.harnessVersionId);
                return (
                  <tr key={`${seriesKey(s)}:${p.harnessVersionId}`}>
                    <th scope="row">{i === 0 ? seriesLabel(s) : ''}</th>
                    <td>
                      {i + 1}. {season?.title ?? p.harnessVersionId}
                    </td>
                    <td className="nowrap">
                      {season ? season.from.slice(0, 10) : '?'} →{' '}
                      {season?.to ? season.to.slice(0, 10) : 'now'}
                    </td>
                    <td className="num">{formatInt(p.runs)}</td>
                    <td className="nowrap">
                      {rateText(p)}{' '}
                      {p.success.value !== null ? (
                        <span className="muted">{formatCi(p.success)}</span>
                      ) : null}
                    </td>
                    <td className="num">
                      {p.success.n} · {p.success.nUnknown} · {p.success.nManual}
                    </td>
                    <td className="num nowrap">
                      {p.costPerRunUsd === null ? 'unknown' : formatUsd(p.costPerRunUsd)}
                      {p.costEstimated ? <span className="est">estimated</span> : null}
                    </td>
                    <td className="num nowrap">
                      {p.vsPrevious ? formatPoints(p.vsPrevious.delta) : '—'}
                    </td>
                    <td>{p.vsPrevious ? <DeltaBadge d={p.vsPrevious} /> : null}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HowComputed({ v }: { v: SeasonsView }) {
  const method = v.series[0]?.perSeason[0]?.success.method;
  return (
    <details className="card how-computed">
      <summary>How these numbers are computed</summary>
      <ul>
        <li>
          <b>Seasons.</b> One chain per (bed, agent): the harness that agent ran inside, from git
          history and observed transcript state. Consecutive versions with no meaningful difference
          (only the entrypoint changed, for example) merge into one season, so every boundary is a
          real change. Titles are the commit subject, or are generated from the diff when the change
          was observed rather than committed.
        </li>
        <li>
          <b>Attribution.</b> A run belongs to the season of the harness version it ran under, not
          to the season its timestamp falls in.
        </li>
        <li>
          <b>Success rate.</b> {method ?? 'success = 1, partial = 0.5, failure = 0.'}
        </li>
        <li>
          <b>Δ vs previous.</b> This season’s rate minus the previous season’s, in rate points.
          “Separated” means the two 95% Wilson intervals don’t overlap; otherwise the difference is
          “within noise” at these sample sizes.
        </li>
        <li>
          <b>Cost.</b> Median per-run cost: tokens deduped per API message × the pricing table,
          computed at query time. “Estimated” when some runs only recorded stream-start output
          tokens.
        </li>
        <li>
          <b>Loop rows.</b> Runs a loop triggered repeat one task, so they get their own row; a
          change in loop volume can’t move the agent’s rate.
        </li>
        <li>
          <b>Window.</b> {v.window.from.slice(0, 10)} → {v.window.to.slice(0, 10)}. Seasons that
          began earlier are clipped to the window; only runs inside it count.
        </li>
      </ul>
    </details>
  );
}
