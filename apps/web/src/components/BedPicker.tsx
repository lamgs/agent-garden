import { useEffect, useRef, useState } from 'react';
import type { GardenView, ID } from '@garden/core';
import { bedLabel } from '../format';
import { compareHref, navigate } from '../route';
import { bedToneOf } from './Specimen';

/** "Compare beds" picker: the first bed is preselected (from a bed label click), choose the second. */
export function BedPicker({
  view,
  initialLeft,
  onClose,
}: {
  view: GardenView;
  initialLeft: ID | null;
  onClose: () => void;
}) {
  const beds = [...view.beds].sort((a, b) => a.name.localeCompare(b.name));
  const [left, setLeft] = useState<ID>(initialLeft ?? beds[0]?.id ?? '');
  const [right, setRight] = useState<ID>(() => {
    const first = initialLeft ?? beds[0]?.id;
    // Default the second bed to the one sharing the most agents with the first.
    const agentsOf = (id: ID | undefined) =>
      new Set(view.plants.filter((p) => p.bedId === id).map((p) => p.agentId));
    const mine = agentsOf(first);
    let best: ID = '';
    let bestN = -1;
    for (const b of beds) {
      if (b.id === first) continue;
      const n = [...agentsOf(b.id)].filter((a) => mine.has(a)).length;
      if (n > bestN) {
        best = b.id;
        bestN = n;
      }
    }
    return best;
  });
  const firstRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    (initialLeft ? document.getElementById('picker-right') : firstRef.current)?.focus();
  }, [initialLeft]);
  const shared = (a: ID, b: ID) => {
    const sa = new Set(view.plants.filter((p) => p.bedId === a).map((p) => p.agentId));
    return view.plants.filter((p) => p.bedId === b && sa.has(p.agentId)).length;
  };
  const go = () => {
    if (!left || !right || left === right) return;
    onClose();
    navigate(compareHref(left, right));
  };
  const tone = (id: ID) => {
    const b = view.beds.find((x) => x.id === id);
    return b ? bedToneOf(b) : 'transparent';
  };
  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-label="Compare beds"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Compare beds</h2>
        <p className="muted">
          Two beds side by side: their harnesses, what differs in the soil, and every agent planted
          in both.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <label>
            <span>
              <span className="bed-chip" style={{ background: tone(left) }} /> First bed
            </span>
            <select
              ref={firstRef}
              value={left}
              onChange={(e) => {
                const id = e.target.value;
                setLeft(id);
                if (id === right) setRight(beds.find((b) => b.id !== id)?.id ?? '');
              }}
            >
              {beds.map((b) => (
                <option key={b.id} value={b.id}>
                  {bedLabel(b)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              <span className="bed-chip" style={{ background: tone(right) }} /> Second bed
            </span>
            <select id="picker-right" value={right} onChange={(e) => setRight(e.target.value)}>
              {beds
                .filter((b) => b.id !== left)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {bedLabel(b)} · {shared(left, b.id)} shared agents
                  </option>
                ))}
            </select>
          </label>
          <div className="picker-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!right || left === right}>
              Compare →
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
