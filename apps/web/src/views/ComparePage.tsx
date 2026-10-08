/**
 * Bed compare (`#/compare?left=&right=`): two beds side by side, the soil difference between
 * them, and every agent planted in both with its success delta, separation badge, and cost ratio.
 */
import { INK, type BedCompareView, type BedSnapshot, type GardenView } from '@garden/core';
import { formatCi, formatPoints, formatRatio, soilChanges } from '../compare-format';
import type { ViewResult } from '../data/views';
import { formatInt, formatUsd, pct } from '../format';
import {
  compareHref,
  knowledgeHref,
  navigate,
  replantHref,
  plantHref,
  seasonsHref,
} from '../route';
import { SoilPlot } from '../components/Specimen';
import {
  BedTag,
  Caveat,
  CiBar,
  HarnessFacts,
  SeparationBadgeView,
  TickText,
  ViewMessage,
} from '../components/ui';
import { LoadingPage, PageShell } from './PageShell';
import { SoilDiffList } from './SoilDiff';

export function ComparePage({
  result,
  garden,
}: {
  result: ViewResult<BedCompareView> | null;
  garden: GardenView | null;
}) {
  const crumb = 'Compare beds';
  if (!result) return <LoadingPage crumb={crumb} />;
  if (result.status !== 'ok') {
    return (
      <PageShell crumb={crumb}>
        <ViewMessage
          title={result.status === 'missing' ? result.title : 'Could not load this comparison'}
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
    <PageShell crumb={`Compare beds · ${v.left.bed.name} vs ${v.right.bed.name}`} table>
      <article className="compare-page">
        <header className="page-title compare-title">
          <div>
            <div className="kicker">Bed compare</div>
            <h2>
              {v.left.bed.name} <span className="vs">vs</span> {v.right.bed.name}
            </h2>
          </div>
          {garden ? <BedSwitcher v={v} garden={garden} /> : null}
        </header>
        <div className="compare-grid">
          <BedColumn snap={v.left} side="left" />
          <section className="soil-diff" aria-label="What differs in the soil">
            <div className="kicker">
              {v.left.bed.name} → {v.right.bed.name}
            </div>
            <h3 className="card-title">What differs in the soil</h3>
            <SoilDiffList items={soilChanges(v.harnessDiff, v.harnessChanges)} />
          </section>
          <BedColumn snap={v.right} side="right" />
        </div>
        <SharedAgents v={v} />
        <div className="compare-harness">
          <section className="card" aria-label={`Harness of ${v.left.bed.name}`}>
            <div className="card-kicker">Harness (the soil)</div>
            <BedTag bed={v.left.bed} as="h3" />
            <HarnessFacts harness={v.left.harness} />
          </section>
          <section className="card" aria-label={`Harness of ${v.right.bed.name}`}>
            <div className="card-kicker">Harness (the soil)</div>
            <BedTag bed={v.right.bed} as="h3" />
            <HarnessFacts harness={v.right.harness} />
          </section>
        </div>
      </article>
    </PageShell>
  );
}

function BedSwitcher({ v, garden }: { v: BedCompareView; garden: GardenView }) {
  const beds = [...garden.beds].sort((a, b) => a.name.localeCompare(b.name));
  const pick = (side: 'left' | 'right', id: string) => {
    const left = side === 'left' ? id : v.left.bed.id;
    const right = side === 'right' ? id : v.right.bed.id;
    if (left !== right) navigate(compareHref(left, right));
  };
  return (
    <div className="bed-switcher">
      <label>
        <span>Left</span>
        <select value={v.left.bed.id} onChange={(e) => pick('left', e.target.value)}>
          {beds.map((b) => (
            <option key={b.id} value={b.id} disabled={b.id === v.right.bed.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Right</span>
        <select value={v.right.bed.id} onChange={(e) => pick('right', e.target.value)}>
          {beds.map((b) => (
            <option key={b.id} value={b.id} disabled={b.id === v.left.bed.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const PLOT_W = 440;

function BedColumn({ snap, side }: { snap: BedSnapshot; side: 'left' | 'right' }) {
  const plants = [...snap.plants].sort((a, b) => b.runs - a.runs);
  const n = plants.length;
  return (
    <section className={`bed-col bed-col-${side}`} aria-label={`Bed ${snap.bed.name}`}>
      <BedTag bed={snap.bed} as="h3" />
      <a className="quiet-link seasons-link" href={seasonsHref(snap.bed.id)}>
        Seasons of {snap.bed.name} →
      </a>
      <p className="quiet-link">
        <a href={knowledgeHref(snap.bed.id)}>Knowledge map →</a>
      </p>
      <SoilPlot
        bed={snap.bed}
        plants={plants.map((p, i) => ({ plant: p, at: (i + 0.5) / Math.max(1, n) }))}
        width={PLOT_W}
        height={196}
        k={0.8}
        label={`${snap.bed.name} with its ${n} plants, drawn as in the garden`}
      />
      <ul
        className="plant-names"
        style={{ width: PLOT_W, gridTemplateColumns: `repeat(${Math.max(1, n)}, 1fr)` }}
      >
        {plants.map((p) => (
          <li key={p.id}>
            <a href={plantHref(p.id)}>{p.name}</a>
            <span className="muted">
              {formatInt(p.runs)} runs · {p.success.value === null ? 'n/a' : pct(p.success.value)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharedAgents({ v }: { v: BedCompareView }) {
  return (
    <section className="card shared" id="shared" aria-label="Agents in both beds">
      <div className="card-kicker">Agents planted in both beds</div>
      <h3 className="card-title">Same agent, different soil</h3>
      <Caveat text={v.caveat} />
      {v.sharedAgents.length === 0 ? (
        <p className="muted">No agent grows in both beds.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table shared-table" aria-label="Shared agents">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">
                  <span className="mk mk-hollow" aria-hidden="true" /> {v.left.bed.name}
                </th>
                <th scope="col">
                  <span className="mk mk-filled" aria-hidden="true" /> {v.right.bed.name}
                </th>
                <th scope="col">Success, 95% CI (0–100%)</th>
                <th scope="col" className="num">
                  Δ success
                </th>
                <th scope="col">Separation</th>
                <th scope="col" className="num">
                  Cost ratio · per run
                </th>
                <th scope="col">
                  <span className="sr-only">Replant</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {v.sharedAgents.map((a) => (
                <tr key={a.agentId}>
                  <th scope="row">{a.name}</th>
                  <td className="nowrap">
                    {a.left.success.value === null ? 'n/a' : pct(a.left.success.value)}{' '}
                    <span className="muted">
                      {formatCi(a.left.success)}, n={a.left.success.n}
                    </span>
                  </td>
                  <td className="nowrap">
                    {a.right.success.value === null ? 'n/a' : pct(a.right.success.value)}{' '}
                    <span className="muted">
                      {formatCi(a.right.success)}, n={a.right.success.n}
                    </span>
                  </td>
                  <td>
                    <span className="ci-pair">
                      <CiBar
                        rate={a.left.success}
                        width={200}
                        marker="hollow"
                        tone={INK.secondary}
                        name={`${a.name} in ${v.left.bed.name}`}
                      />
                      <CiBar
                        rate={a.right.success}
                        width={200}
                        marker="filled"
                        name={`${a.name} in ${v.right.bed.name}`}
                      />
                    </span>
                  </td>
                  <td className="num delta">{formatPoints(a.success.delta)}</td>
                  <td>
                    <SeparationBadgeView d={a.success} />
                  </td>
                  <td className="num nowrap">
                    {formatRatio(a.costRatio)}{' '}
                    <span className="muted">
                      {a.left.costPerRunUsd === null ? '?' : formatUsd(a.left.costPerRunUsd)} →{' '}
                      {a.right.costPerRunUsd === null ? '?' : formatUsd(a.right.costPerRunUsd)}
                      {a.left.costEstimated || a.right.costEstimated ? ' (estimated)' : ''}
                    </span>
                  </td>
                  <td className="nowrap">
                    <a href={replantHref(a.agentId, v.left.bed.id, v.right.bed.id)}>
                      Replant view →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        Δ = right − left in rate points. “Separated” means the two 95% Wilson intervals don’t
        overlap. Cost ratio = right ÷ left median cost per run.
      </p>
    </section>
  );
}
