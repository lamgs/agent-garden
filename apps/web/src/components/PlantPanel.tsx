import { useEffect, useRef } from 'react';
import type { GardenView, ID } from '@garden/core';
import { describePlant, plantLabel } from '../describe';
import { formatRate } from '../format';
import { plantHref } from '../route';
import { DescriptionBody } from './Tooltip';

/** Side panel for a selected plant. M4 grows this into the full Plant view. */
export function PlantPanel({
  view,
  plantId,
  onClose,
  onSelect,
}: {
  view: GardenView;
  plantId: ID;
  onClose: () => void;
  onSelect: (id: ID) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), [plantId]);
  const p = view.plants.find((x) => x.id === plantId);
  if (!p) return null;
  const d = describePlant(view, p);
  const loops = view.loops.filter((l) => l.targetPlantIds.includes(p.id));
  const out = view.bees.filter((b) => b.fromPlantId === p.id);
  const inn = view.bees.filter((b) => b.toPlantId === p.id);
  const steps = view.playbooks.flatMap((pb) =>
    pb.steps.map((s, i) => ({ pb, s, i })).filter(({ s }) => s.plantId === p.id),
  );
  const others = view.plants.filter((x) => x.agentId === p.agentId && x.id !== p.id);
  return (
    <aside className="plant-panel" aria-label={`Plant: ${p.name}`}>
      <button
        ref={ref}
        type="button"
        className="icon-btn panel-close"
        onClick={onClose}
        aria-label="Close panel (Esc)"
      >
        ×
      </button>
      <DescriptionBody d={d} />
      <p className="panel-open">
        <a className="open-plant" href={plantHref(p.id)}>
          Open plant view →
        </a>
        <span className="muted"> runs, evidence, labels</span>
      </p>
      {loops.length ? (
        <section>
          <h4>Watered by loops</h4>
          <ul>
            {loops.map((l) => (
              <li key={l.loopId}>
                <span className={`state state-${l.state}`}>{l.state}</span> {l.name} ·{' '}
                {l.observed === false ? 'not recorded' : `${l.runsPerDay.toFixed(2)}/day`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {out.length || inn.length ? (
        <section>
          <h4>Subagent handoffs</h4>
          <ul>
            {out.map((b) => (
              <li key={`o${b.toPlantId}`}>
                → {plantLabel(view, b.toPlantId)}: {b.calls} calls
              </li>
            ))}
            {inn.map((b) => (
              <li key={`i${b.fromPlantId}`}>
                ← {plantLabel(view, b.fromPlantId)}: {b.calls} calls
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {steps.length ? (
        <section>
          <h4>Playbook steps</h4>
          <ul>
            {steps.map(({ pb, s, i }) => (
              <li key={`${pb.id}:${i}`}>
                <span className={`state gate-${s.gate}`}>{s.gate}</span> {pb.name} · {s.stepId}:{' '}
                {s.evidence}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {others.length ? (
        <section>
          <h4>Same agent in other beds</h4>
          <ul>
            {others.map((o) => (
              <li key={o.id}>
                <button type="button" className="link-btn" onClick={() => onSelect(o.id)}>
                  {view.beds.find((b) => b.id === o.bedId)?.name ?? o.bedId}
                </button>
                : {formatRate(o.success)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
