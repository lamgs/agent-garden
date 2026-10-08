/**
 * Plant view (`#/plant/:id`): a field-guide specimen page for one planting (agent in a bed).
 * Every number here also appears with how it was computed: the rate with n, CI, and its
 * evidence (outcome mix + heuristic signal counts), and each run's signals with their details.
 */
import { Fragment, useState, type ReactNode } from 'react';
import {
  INK,
  LOOP_TIERS,
  plantBloom,
  plantDroop,
  plantFade,
  plantHeight,
  plantHue,
  type GardenView,
  type ID,
  type LoopTier,
  type OutcomeLabel,
  type PlantView,
  type RunRow,
} from '@garden/core';
import {
  formatDateTime,
  formatDuration,
  formatTokens,
  formatWeight,
  signalName,
} from '../compare-format';
import { labelingDisabledReason, postLabel, type ViewResult } from '../data/views';
import type { DataSource } from '../data/load';
import {
  formatCostPerRun,
  formatInt,
  formatLastRun,
  formatShare,
  formatTotalCost,
  formatUsd,
  pct,
  shortModel,
  truncate,
} from '../format';
import { plantHref, replantHref, seasonsHref } from '../route';
import { PlantSprite, SoilPlot } from '../components/Specimen';
import {
  BedTag,
  Card,
  CiBar,
  Facts,
  HarnessFacts,
  LevelChip,
  OutcomeBadge,
  OutcomeDot,
  OutcomeMixBar,
  RateLine,
  TickText,
  ViewMessage,
} from '../components/ui';
import { LoadingPage, PageShell } from './PageShell';

const TIER_LABEL: Record<LoopTier, [string, string]> = {
  agent: ['Agent', 'seconds · every other step'],
  verification: ['Verification', 'minutes · tests, hooks, reviewer subagents'],
  application: ['Application', 'hours · commit, push, PR'],
  hill_climbing: ['Hill-climbing', 'days · edits to harness files'],
};

export function PlantPage({
  result,
  garden,
  onReload,
}: {
  result: ViewResult<PlantView> | null;
  garden: GardenView | null;
  onReload: () => void;
}) {
  const crumb = 'Plant';
  if (!result) return <LoadingPage crumb={crumb} />;
  if (result.status !== 'ok') {
    return (
      <PageShell crumb={crumb}>
        <ViewMessage
          title={result.status === 'missing' ? result.title : 'Could not load this plant'}
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
    <PageShell crumb={`Plant · ${result.data.agent.name} in ${result.data.bed.name}`} table>
      <PlantBody v={result.data} source={result.source} garden={garden} onReload={onReload} />
    </PageShell>
  );
}

function bedNameOf(garden: GardenView | null, bedId: ID): string {
  return garden?.beds.find((b) => b.id === bedId)?.name ?? bedId;
}

function PlantBody({
  v,
  source,
  garden,
  onReload,
}: {
  v: PlantView;
  source: DataSource;
  garden: GardenView | null;
  onReload: () => void;
}) {
  const p = v.plant;
  const def = v.agent.definition;
  return (
    <article className="plant-page">
      <header className="specimen">
        <figure className="plate">
          <SoilPlot
            bed={v.bed}
            plants={[{ plant: p, at: 0.5 }]}
            width={300}
            height={300}
            k={1.75}
            label={`${p.name} drawn as in the garden, standing in the ${v.bed.name} bed`}
          />
          <figcaption>
            Drawn by the garden’s own code: height, bloom, droop, fade and foliage are the numbers
            on the right. Press <kbd>L</kbd> for the legend.
          </figcaption>
        </figure>
        <div className="specimen-text">
          <div className="kicker">
            {v.agent.kind === 'main' ? 'Main thread' : 'Subagent'} · planted in
          </div>
          <BedTag bed={v.bed} />
          <h2 className="specimen-name">{v.agent.name}</h2>
          {def?.description ? <p className="specimen-desc">{def.description}</p> : null}
          <dl className="key-numbers">
            <KeyNumber
              label="Runs"
              channel="height"
              value={formatInt(p.runs)}
              level={plantHeight.levels[plantHeight.level(p)]}
            />
            <KeyNumber
              label="Success"
              channel="bloom"
              value={<RateLine rate={p.success} />}
              level={plantBloom.levels[plantBloom.level(p)]}
            />
            <KeyNumber
              label="Failure share, last 14 days"
              channel="droop"
              value={formatShare(p.recentFailureShare)}
              level={plantDroop.levels[plantDroop.level(p)]}
            />
            <KeyNumber
              label="Last run"
              channel="fade"
              value={formatLastRun(p)}
              level={plantFade.levels[plantFade.level(p)]}
            />
            <KeyNumber
              label="Cost per run"
              channel="foliage"
              value={
                p.costPerRunUsd === null ? (
                  formatCostPerRun(p)
                ) : (
                  <>
                    {formatUsd(p.costPerRunUsd)} <span className="muted">median</span>
                    {p.costEstimated ? <span className="est">estimated</span> : null}
                  </>
                )
              }
              level={plantHue.levels[plantHue.level(p)]}
            />
            <KeyNumber label="Total cost" value={formatTotalCost(p)} />
          </dl>
        </div>
      </header>

      <div className="grid-2-1">
        <WhyThisRate v={v} />
        <div className="stack">
          <Card title="Capability card" kicker="What this agent is">
            <Facts
              rows={[
                ['Kind', v.agent.kind === 'main' ? 'main thread' : 'subagent'],
                ['Scope', def?.scope ?? 'built-in or undefined'],
                [
                  'Model',
                  def?.model
                    ? def.model === 'inherit'
                      ? 'inherits the harness model'
                      : shortModel(def.model)
                    : 'harness default',
                ],
                [
                  'Allowed tools',
                  def?.tools?.length ? (
                    <span className="chips">
                      {def.tools.map((t) => (
                        <span className="chip" key={t}>
                          {t}
                        </span>
                      ))}
                    </span>
                  ) : (
                    'all tools of the harness'
                  ),
                ],
                ...(def?.path
                  ? ([
                      [
                        'Definition',
                        <code key="p">{def.path.split('/').slice(-2).join('/')}</code>,
                      ],
                    ] as [string, ReactNode][])
                  : []),
              ]}
            />
          </Card>
          <Card title="Harness (the soil)" kicker={`Bed ${v.bed.name}`}>
            <HarnessFacts harness={v.harness} />
            <p className="seasons-link">
              <a href={seasonsHref(v.bed.id)}>Seasons of {v.bed.name}: outcomes per harness →</a>
            </p>
          </Card>
        </div>
      </div>

      <div className="grid-3">
        <TierCard tiers={v.tierBreakdown} />
        <CapabilitiesCard v={v} />
        <OtherBeds v={v} garden={garden} />
      </div>

      <RunsTable v={v} source={source} onReload={onReload} />
    </article>
  );
}

function KeyNumber({
  label,
  channel,
  value,
  level,
}: {
  label: string;
  channel?: string;
  value: ReactNode;
  level?: string;
}) {
  return (
    <div className="key-number">
      <dt>
        {label}
        {channel ? <span className="channel"> · {channel}</span> : null}
      </dt>
      <dd>
        {value}
        {level ? <LevelChip>{level}</LevelChip> : null}
      </dd>
    </div>
  );
}

function WhyThisRate({ v }: { v: PlantView }) {
  const r = v.plant.success;
  return (
    <Card title="Why this rate" kicker="The evidence behind the bloom" className="why">
      <div className="why-head">
        <div className="big-rate">{r.value === null ? '—' : pct(r.value)}</div>
        <div className="why-ci">
          <CiBar rate={r} width={300} name="success" />
          <div className="ci-text">
            {r.ci95 ? (
              <>
                95% Wilson interval{' '}
                <b>
                  {pct(r.ci95[0])}–{pct(r.ci95[1])}
                </b>
              </>
            ) : (
              'no interval (no labeled runs)'
            )}
          </div>
          <div className="counts">
            <span className="n-label">n={formatInt(r.n)}</span> labeled runs ·{' '}
            {formatInt(r.nUnknown)} unknown (excluded) · {formatInt(r.nManual)} manual{' '}
            {r.nManual === 1 ? 'label' : 'labels'}
          </div>
        </div>
      </div>
      <p className="method">{r.method}</p>
      <h4>Outcome mix</h4>
      <OutcomeMixBar mix={v.outcomeMix} />
      <h4>Heuristic signals across {formatInt(v.runsTotal)} runs</h4>
      <div className="table-scroll">
        <table className="data-table signals-table">
          <thead>
            <tr>
              <th scope="col">Signal</th>
              <th scope="col" className="num">
                Weight
              </th>
              <th scope="col" className="num">
                Fired
              </th>
              <th scope="col" className="num">
                Not fired
              </th>
              <th scope="col" className="num">
                n/a
              </th>
              <th scope="col">Fired in (of applicable runs)</th>
              <th scope="col">What it checks</th>
            </tr>
          </thead>
          <tbody>
            {v.signalStats.map((s) => {
              const applicable = s.fired + s.notFired;
              const share = applicable ? s.fired / applicable : null;
              return (
                <tr key={s.id}>
                  <th scope="row">
                    {signalName(s.id)}
                    <code className="sig-id">{s.id}</code>
                  </th>
                  <td className="num">{formatWeight(s.weight)}</td>
                  <td className="num">{formatInt(s.fired)}</td>
                  <td className="num">{formatInt(s.notFired)}</td>
                  <td className="num muted-cell">{formatInt(s.notApplicable)}</td>
                  <td>
                    {share === null ? (
                      <span className="muted">never applicable</span>
                    ) : (
                      <ShareBar
                        share={share}
                        tip={`${signalName(s.id)}: fired in ${s.fired} of ${applicable} applicable runs (${pct(share)}); ${s.notApplicable} not applicable`}
                      />
                    )}
                  </td>
                  <td className="desc-cell">{s.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ShareBar({
  share,
  tip,
  width = 120,
}: {
  share: number;
  tip: string;
  width?: number;
}) {
  return (
    <span className="share-bar" data-tip={tip}>
      <svg width={width} height={8} aria-hidden="true">
        <rect x={0} y={2} width={width} height={4} rx={2} fill={INK.hairline} />
        <rect
          x={0}
          y={1}
          width={Math.max(share > 0 ? 3 : 0, share * width)}
          height={6}
          rx={3}
          fill={INK.secondary}
        />
      </svg>
      <span className="share-text">{pct(share)}</span>
    </span>
  );
}

function TierCard({ tiers }: { tiers: Record<LoopTier, number> }) {
  const total = LOOP_TIERS.reduce((s, t) => s + tiers[t], 0);
  const max = Math.max(1, ...LOOP_TIERS.map((t) => tiers[t]));
  return (
    <Card title="Loop tiers" kicker="Steps per tier">
      <ul className="bars tier-bars">
        {LOOP_TIERS.map((t) => (
          <li key={t}>
            <span className="bar-label">
              {TIER_LABEL[t][0]} <span className="muted">{TIER_LABEL[t][1]}</span>
            </span>
            <span
              className="bar-track"
              data-tip={`${TIER_LABEL[t][0]} tier: ${formatInt(tiers[t])} of ${formatInt(total)} steps${total ? ` (${pct(tiers[t] / total)})` : ''}`}
            >
              <span className="bar-fill" style={{ width: `${(tiers[t] / max) * 100}%` }} />
            </span>
            <span className="bar-value">{formatInt(tiers[t])}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        {formatInt(total)} steps across this planting’s runs, classified at ingestion: edits to
        CLAUDE.md or .claude/ files are hill-climbing, ship commands application, test commands,
        hooks and reviewer subagents verification; everything else is agent.
      </p>
    </Card>
  );
}

function CallBars({ items, empty }: { items: { name: string; calls: number }[]; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.calls));
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.name}>
          <span className="bar-label">{i.name}</span>
          <span className="bar-track" data-tip={`${i.name}: ${formatInt(i.calls)} calls`}>
            <span className="bar-fill" style={{ width: `${(i.calls / max) * 100}%` }} />
          </span>
          <span className="bar-value">{formatInt(i.calls)}</span>
        </li>
      ))}
    </ul>
  );
}

function CapabilitiesCard({ v }: { v: PlantView }) {
  const c = v.capabilities;
  return (
    <Card title="Capabilities actually used" kicker="In this planting’s runs">
      <h4>Top tools</h4>
      <CallBars items={c.tools} empty="No tool calls recorded." />
      <h4>Skills</h4>
      <CallBars
        items={c.skills.map((s) => ({ name: s.name, calls: s.invocations }))}
        empty="No skill invocations."
      />
      <h4>MCP servers</h4>
      <CallBars items={c.mcpServers} empty="No MCP calls." />
    </Card>
  );
}

function OtherBeds({ v, garden }: { v: PlantView; garden: GardenView | null }) {
  return (
    <Card title="Same agent, other beds" kicker="Other plantings">
      {v.otherBeds.length === 0 ? (
        <p className="muted">This agent grows only in {v.bed.name}.</p>
      ) : (
        <ul className="other-beds">
          {v.otherBeds.map((o) => {
            const name = bedNameOf(garden, o.bedId);
            return (
              <li key={o.id}>
                <PlantSprite plant={o} height={78} />
                <div>
                  <div className="other-name">{name}</div>
                  <RateLine rate={o.success} />
                  <div className="muted">
                    {formatInt(o.runs)} runs ·{' '}
                    {o.costPerRunUsd === null
                      ? 'cost unknown'
                      : `${formatUsd(o.costPerRunUsd)}/run`}
                    {o.costEstimated ? ' (estimated)' : ''}
                  </div>
                  <div className="other-links">
                    <a href={replantHref(v.agent.id, v.bed.id, o.bedId)}>Compare in {name} →</a>
                    <a href={plantHref(o.id)} className="quiet-link">
                      Open plant
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const TRIGGER: Record<RunRow['trigger'], string> = {
  human: 'human',
  automated: 'loop',
  subagent: 'parent',
};

function RunsTable({
  v,
  source,
  onReload,
}: {
  v: PlantView;
  source: DataSource;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Set<ID>>(() => new Set());
  const toggle = (id: ID) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const disabled = labelingDisabledReason(source);
  return (
    <Card title="Runs" kicker="Most recent first" className="runs-card" id="runs">
      <p className="table-note">
        Showing {formatInt(v.runs.length)} of {formatInt(v.runsTotal)} runs in the window. Expand a
        row for the signals behind its outcome
        {disabled ? ' (labels are read-only here)' : ' and to set a manual label'}. Manual labels
        always win over heuristics.
      </p>
      <div className="table-scroll">
        <table className="data-table runs-table" aria-label="Runs">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Expand</span>
              </th>
              <th scope="col">Started (UTC)</th>
              <th scope="col">Task</th>
              <th scope="col">Trigger</th>
              <th scope="col">Outcome</th>
              <th scope="col" className="num">
                Score
              </th>
              <th scope="col" className="num">
                Tokens
              </th>
              <th scope="col" className="num">
                Cost
              </th>
              <th scope="col" className="num">
                Duration
              </th>
              <th scope="col" className="num">
                Errors
              </th>
              <th scope="col" className="num">
                Subagents
              </th>
            </tr>
          </thead>
          <tbody>
            {v.runs.map((r) => {
              const isOpen = open.has(r.runId);
              return (
                <Fragment key={r.runId}>
                  <tr className={isOpen ? 'run-open' : undefined} data-run-id={r.runId}>
                    <td>
                      <button
                        type="button"
                        className="expander"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Collapse' : 'Expand'} run ${formatDateTime(r.startedAt)}`}
                        onClick={() => toggle(r.runId)}
                      >
                        {isOpen ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="nowrap">{formatDateTime(r.startedAt)}</td>
                    <td className="task-cell" title={r.taskPreview}>
                      {truncate(r.taskPreview, 84)}
                    </td>
                    <td>{TRIGGER[r.trigger]}</td>
                    <td className="nowrap">
                      <OutcomeBadge label={r.outcome.label} />
                      {r.outcome.source === 'manual' ? (
                        <span
                          className="manual-chip"
                          data-tip={`Manual label${r.outcome.manual ? ` set ${r.outcome.manual.at.slice(0, 10)}` : ''}; the heuristics said “${r.outcome.heuristicLabel}”.`}
                        >
                          manual · heuristic {r.outcome.heuristicLabel}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">
                      {r.outcome.score === null ? '—' : r.outcome.score.toFixed(2)}
                    </td>
                    <td className="num">{formatTokens(r.totalTokens)}</td>
                    <td className="num nowrap">
                      {r.costUsd === null ? (
                        <span className="muted">unpriced</span>
                      ) : (
                        formatUsd(r.costUsd)
                      )}
                      {r.costEstimated ? <span className="est">est.</span> : null}
                    </td>
                    <td className="num nowrap">{formatDuration(r.durationMs)}</td>
                    <td className="num">{r.errorCount}</td>
                    <td className="num">{r.childCount}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="run-detail">
                      <td />
                      <td colSpan={10}>
                        <RunDetail run={r} disabled={disabled} onSaved={onReload} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SignalMark({ fired }: { fired: boolean | null }) {
  if (fired === null) return <span className="sig-mark sig-na">n/a</span>;
  return fired ? (
    <span className="sig-mark sig-fired">● fired</span>
  ) : (
    <span className="sig-mark sig-not">○ not fired</span>
  );
}

function RunDetail({
  run,
  disabled,
  onSaved,
}: {
  run: RunRow;
  disabled: string | null;
  onSaved: () => void;
}) {
  return (
    <div className="run-detail-grid">
      <div>
        <h4>Signals behind this outcome</h4>
        <p className="muted">
          Heuristic label <b>{run.outcome.heuristicLabel}</b>
          {run.outcome.score === null ? '' : `, score ${run.outcome.score.toFixed(2)}`} ·{' '}
          {run.model ? shortModel(run.model) : 'model unknown'} · {run.toolCallCount} tool calls
        </p>
        <ul className="signal-list">
          {run.outcome.signals.map((s) => (
            <li key={s.id} className={s.fired === null ? 'na' : undefined}>
              <SignalMark fired={s.fired} />
              <span className="sig-name">
                {signalName(s.id)} <span className="muted">{formatWeight(s.weight)}</span>
              </span>
              <span className="sig-detail">{s.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <LabelControls run={run} disabled={disabled} onSaved={onSaved} />
    </div>
  );
}

const LABEL_BUTTONS: OutcomeLabel[] = ['success', 'partial', 'failure', 'unknown'];

function LabelControls({
  run,
  disabled,
  onSaved,
}: {
  run: RunRow;
  disabled: string | null;
  onSaved: () => void;
}) {
  // The note box starts empty; a saved note is shown as the server stored it (redacted).
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const manual = run.outcome.source === 'manual' ? run.outcome.manual : undefined;
  const send = async (label: OutcomeLabel | 'clear') => {
    setBusy(true);
    setMsg(null);
    try {
      await postLabel(run.runId, { label, note });
      setMsg({
        kind: 'ok',
        text: label === 'clear' ? 'Manual label cleared.' : `Saved: ${label} (manual).`,
      });
      setNote('');
      onSaved();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const off = disabled !== null || busy;
  const noteId = `note-${run.runId}`;
  return (
    <div className="label-controls" aria-label="Manual label">
      <h4>Label this run</h4>
      <p className="muted">
        {manual ? (
          <>
            Currently <b>manual: {manual.label}</b> (set {manual.at.slice(0, 10)}); heuristics said{' '}
            {run.outcome.heuristicLabel}.
            {manual.note ? (
              <span className="saved-note">Saved note (as stored, redacted): “{manual.note}”</span>
            ) : null}
          </>
        ) : (
          <>
            Currently the heuristic label ({run.outcome.heuristicLabel}). A manual label overrides
            it.
          </>
        )}
      </p>
      <div className="label-buttons" role="group" aria-label="Set label">
        {LABEL_BUTTONS.map((l) => (
          <button
            key={l}
            type="button"
            disabled={off}
            aria-pressed={manual?.label === l}
            onClick={() => void send(l)}
          >
            <OutcomeDot label={l} /> {l.charAt(0).toUpperCase() + l.slice(1)}
          </button>
        ))}
        <button
          type="button"
          className="clear-btn"
          disabled={off || !manual}
          onClick={() => void send('clear')}
        >
          Clear
        </button>
      </div>
      <label className="note-field" htmlFor={noteId}>
        <span>Note (optional, redacted by the server)</span>
        <textarea
          id={noteId}
          rows={2}
          maxLength={2000}
          value={note}
          disabled={off}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why this label?"
        />
      </label>
      {disabled ? (
        <p className="label-disabled" role="note">
          <TickText text={disabled} />
        </p>
      ) : null}
      {msg ? (
        <p
          className={msg.kind === 'error' ? 'label-error' : 'label-ok'}
          role={msg.kind === 'error' ? 'alert' : 'status'}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
