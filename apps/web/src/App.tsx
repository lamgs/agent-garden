import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID } from '@garden/core';
import { GardenStage, type GardenStageHandle } from './components/GardenStage';
import { Legend } from './components/Legend';
import { PlantPanel } from './components/PlantPanel';
import { TableView } from './components/TableView';
import { loadGarden, SOURCE_LABEL, type Loaded } from './data/load';
import type { ZoomLevel } from './garden/renderer';

export const TAGLINE =
  "See every AI agent you run as a living garden: what's thriving, what's wilting, and which one to call.";

const WINDOWS = [30, 90, 180] as const;
const ZOOM_LABEL: Record<ZoomLevel, string> = {
  far: 'Far: beds',
  mid: 'Mid: plants',
  near: 'Near: labels & care cards',
};

export function App() {
  const [days, setDays] = useState<number>(90);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ID | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>('mid');
  const stage = useRef<GardenStageHandle>(null);
  const selRef = useRef<ID | null>(null);
  selRef.current = selected;

  useEffect(() => {
    let live = true;
    setError(null);
    loadGarden(days)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [days]);

  const onKey = useCallback((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'l' || e.key === 'L') setLegendOpen((o) => !o);
    else if (e.key === 't' || e.key === 'T') setTableOpen((o) => !o);
    else if (e.key === 'Escape') {
      if (selRef.current) setSelected(null);
      else {
        setLegendOpen(false);
        setTableOpen(false);
      }
    } else if (e.key === '+' || e.key === '=') stage.current?.zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') stage.current?.zoomBy(0.8);
    else if (e.key === '0') stage.current?.fit();
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  const fixed = data?.source !== 'api';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1>Agent Garden</h1>
          <p className="tagline">{TAGLINE}</p>
        </div>
        <div className="header-controls">
          <label className="window-select">
            <span>Window</span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              disabled={fixed}
              title={fixed ? 'This data source has a fixed window' : 'Days of history to show'}
            >
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <span className={`source source-${data?.source ?? 'none'}`} title={data?.detail}>
            <span className="source-dot" aria-hidden="true" />
            {data
              ? `${SOURCE_LABEL[data.source]} · ${data.detail}`
              : error
                ? 'no data'
                : 'loading…'}
          </span>
          {data ? (
            <span className="window-dates">
              {data.view.window.from.slice(0, 10)} → {data.view.window.to.slice(0, 10)}
            </span>
          ) : null}
        </div>
      </header>

      <main className={`stage${legendOpen ? ' legend-open' : ''}`}>
        {error ? (
          <div className="empty">
            <h2>No garden yet</h2>
            <p>{error}</p>
          </div>
        ) : null}
        {data ? (
          <GardenStage
            ref={stage}
            view={data.view}
            selectedId={selected}
            onSelect={setSelected}
            onZoomLevel={setZoom}
          />
        ) : null}

        <div className="toolbar" role="toolbar" aria-label="Garden controls">
          <button
            type="button"
            onClick={() => stage.current?.zoomBy(1.25)}
            aria-label="Zoom in (+)"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => stage.current?.zoomBy(0.8)}
            aria-label="Zoom out (−)"
          >
            −
          </button>
          <button type="button" onClick={() => stage.current?.fit()} aria-label="Fit garden (0)">
            fit
          </button>
          <span className="zoom-level" aria-live="polite">
            {ZOOM_LABEL[zoom]}
          </span>
          <span className="toolbar-sep" />
          <button
            type="button"
            className={legendOpen ? 'on' : ''}
            onClick={() => setLegendOpen((o) => !o)}
            aria-pressed={legendOpen}
          >
            Legend <kbd>L</kbd>
          </button>
          <button
            type="button"
            className={tableOpen ? 'on' : ''}
            onClick={() => setTableOpen((o) => !o)}
            aria-pressed={tableOpen}
          >
            Table <kbd>T</kbd>
          </button>
        </div>
        <p className="hint">
          Drag to pan · scroll or pinch to zoom · Tab through plants · Enter opens · Esc closes
        </p>

        {tableOpen && data ? (
          <div className="table-overlay">
            <TableView view={data.view} onSelect={setSelected} />
          </div>
        ) : null}
        {selected && data ? (
          <PlantPanel
            view={data.view}
            plantId={selected}
            onClose={() => setSelected(null)}
            onSelect={setSelected}
          />
        ) : null}
        <Legend open={legendOpen} onClose={() => setLegendOpen(false)} />
      </main>
    </div>
  );
}
