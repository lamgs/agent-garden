import { useCallback, useEffect, useRef, useState } from 'react';
import type { ID } from '@garden/core';
import { BedPicker } from './components/BedPicker';
import { GardenStage, type GardenStageHandle } from './components/GardenStage';
import { Legend } from './components/Legend';
import { PlantPanel } from './components/PlantPanel';
import { TableView } from './components/TableView';
import { HoverTipLayer } from './components/ui';
import { loadGarden, SOURCE_LABEL, type Loaded } from './data/load';
import type { ViewRoute } from './data/views';
import type { ZoomLevel } from './garden/renderer';
import { navigate, parseRoute, type Route } from './route';
import { ComparePage } from './views/ComparePage';
import { PageShell } from './views/PageShell';
import { PlantPage } from './views/PlantPage';
import { ReplantPage } from './views/ReplantPage';
import { ReplayRoute } from './replay/ReplayPage';
import { useView } from './views/useView';
import { ViewMessage } from './components/ui';

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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  /** null = closed; '' = open with no preselected bed. */
  const [picker, setPicker] = useState<ID | '' | null>(null);
  const stage = useRef<GardenStageHandle>(null);
  const selRef = useRef<ID | null>(null);
  selRef.current = selected;
  const stateRef = useRef({ route, legendOpen, picker });
  stateRef.current = { route, legendOpen, picker };

  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(window.location.hash));
      setPicker(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // A page view starts at the top and its title is announced via document.title.
  useEffect(() => {
    document.querySelector('[data-page]')?.scrollTo?.(0, 0);
    document.title = route.view === 'garden' ? 'Agent Garden' : `Agent Garden · ${route.view}`;
  }, [route]);

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
    const { route: r, legendOpen: lo, picker: pk } = stateRef.current;
    if (pk !== null) {
      if (e.key === 'Escape') setPicker(null);
      return;
    }
    if (r.view !== 'garden') {
      // Pages: L = legend, T = jump to this page's table, Esc = legend first, then the garden.
      if (e.key === 'l' || e.key === 'L') setLegendOpen((o) => !o);
      else if (e.key === 't' || e.key === 'T') {
        const el = document.querySelector<HTMLElement>('#runs, #shared, #numbers');
        el?.scrollIntoView({ block: 'start' });
        el?.querySelector<HTMLElement>('table')?.focus();
      } else if (e.key === 'Escape') {
        if (lo) setLegendOpen(false);
        else navigate('#/');
      }
      return;
    }
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
  const onPage = route.view !== 'garden';

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

      <main className={`stage${legendOpen ? ' legend-open' : ''}${onPage ? ' on-page' : ''}`}>
        {error ? (
          <div className="empty">
            <h2>No garden yet</h2>
            <p>{error}</p>
          </div>
        ) : null}
        {data ? (
          <div className="garden-layer" inert={onPage} aria-hidden={onPage}>
            <GardenStage
              ref={stage}
              view={data.view}
              selectedId={selected}
              onSelect={setSelected}
              onZoomLevel={setZoom}
              onBedLabel={(id) => setPicker(id)}
            />
          </div>
        ) : null}

        <div className="toolbar" role="toolbar" aria-label="Garden controls" inert={onPage}>
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
          <span className="toolbar-sep" />
          <button type="button" onClick={() => setPicker('')} disabled={!data}>
            Compare beds
          </button>
        </div>
        <p className="hint">
          Drag to pan · scroll or pinch to zoom · Tab through plants · Enter opens · click a bed
          label to compare beds
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
        {onPage ? <RoutedPage route={route} days={days} garden={data?.view ?? null} /> : null}
        {picker !== null && data ? (
          <BedPicker
            view={data.view}
            initialLeft={picker || null}
            onClose={() => setPicker(null)}
          />
        ) : null}
        <Legend open={legendOpen} onClose={() => setLegendOpen(false)} />
        {onPage ? <HoverTipLayer /> : null}
      </main>
    </div>
  );
}

function RoutedPage({
  route,
  days,
  garden,
}: {
  route: Route;
  days: number;
  garden: Loaded['view'] | null;
}) {
  if (route.view === 'garden') return null;
  if (route.view === 'replay')
    return <ReplayRoute runId={route.runId} plantId={route.plantId} days={days} />;
  if (route.view === 'unknown') {
    return (
      <PageShell crumb="Not found">
        <ViewMessage title="No such page">
          <p>
            <code>#{route.hash}</code> is not a garden route. Pages are <code>#/plant/:id</code>,{' '}
            <code>#/compare?left=&amp;right=</code>, <code>#/replant?agent=&amp;from=&amp;to=</code>
            , and <code>#/replay/:runId</code>.
          </p>
        </ViewMessage>
      </PageShell>
    );
  }
  return <ViewPage key={route.view} route={route} days={days} garden={garden} />;
}

function ViewPage({
  route,
  days,
  garden,
}: {
  route: ViewRoute;
  days: number;
  garden: Loaded['view'] | null;
}) {
  const { result, reload } = useView(route, days);
  switch (route.view) {
    case 'plant':
      return (
        <PlantPage
          result={result as Parameters<typeof PlantPage>[0]['result']}
          garden={garden}
          onReload={reload}
        />
      );
    case 'compare':
      return (
        <ComparePage
          result={result as Parameters<typeof ComparePage>[0]['result']}
          garden={garden}
        />
      );
    case 'replant':
      return (
        <ReplantPage
          result={result as Parameters<typeof ReplantPage>[0]['result']}
          garden={garden}
        />
      );
  }
}
