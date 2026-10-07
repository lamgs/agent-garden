import { useEffect, useRef } from 'react';
import { legend, type LegendEntry } from '@garden/core';
import { CanvasPen } from '../garden/pen';
import { SWATCHES } from '../garden/swatches';

const SWATCH_H = 44;

/** One legend level, drawn by the same code that draws the garden. */
export function SwatchCanvas({ id, level, label }: { id: string; level: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sw = SWATCHES[id];
  const h = sw?.height ?? SWATCH_H;
  const w = sw ? Math.max(24, Math.round((sw.frame.w / sw.frame.h) * h)) : h;
  useEffect(() => {
    const c = ref.current;
    if (!c || !sw) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const k = Math.min(w / sw.frame.w, h / sw.frame.h) * dpr;
    ctx.setTransform(k, 0, 0, k, -sw.frame.x * k, -sw.frame.y * k);
    ctx.clearRect(sw.frame.x, sw.frame.y, sw.frame.w, sw.frame.h);
    sw.draw(new CanvasPen(ctx), level);
  }, [sw, level, w, h]);
  return (
    <canvas
      ref={ref}
      className="swatch"
      style={{ width: w, height: h }}
      role="img"
      aria-label={label}
    />
  );
}

function Entry({ e }: { e: LegendEntry }) {
  return (
    <section className="legend-entry" data-encoding-id={e.id}>
      <header>
        <span className="legend-element">{e.element.replace('_', ' ')}</span>
        <h3>{e.channel}</h3>
      </header>
      <p className="legend-metric">
        <b>Encodes:</b> {e.metric}
      </p>
      <ul className="legend-levels">
        {e.levels.map((label, i) => (
          <li key={i}>
            <SwatchCanvas id={e.id} level={i} label={`${e.channel}: ${label}`} />
            <span>{label}</span>
          </li>
        ))}
      </ul>
      <p className="legend-action">
        <b>Act:</b> {e.action}
      </p>
      <details className="legend-how">
        <summary>How computed</summary>
        <p>{e.howComputed}</p>
      </details>
    </section>
  );
}

/** Legend drawer, generated only from the encodings registry (`legend()`) and the palette. */
export function Legend({ open, onClose }: { open: boolean; onClose: () => void }) {
  const entries = legend();
  return (
    <aside
      className={`legend-drawer${open ? ' open' : ''}`}
      aria-label="Legend"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="drawer-head">
        <h2>Legend</h2>
        <p className="drawer-sub">
          Every visual property encodes a metric. Generated from the encodings registry (
          {entries.length} channels).
        </p>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close legend (Esc)"
        >
          ×
        </button>
      </div>
      <div className="legend-list">
        {entries.map((e) => (
          <Entry key={e.id} e={e} />
        ))}
      </div>
    </aside>
  );
}
