import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { GardenView, ID } from '@garden/core';
import { describe, targetKey, type HoverTarget } from '../describe';
import { formatRate } from '../format';
import { GardenRenderer, type ZoomLevel } from '../garden/renderer';
import { DescriptionBody } from './Tooltip';

export interface GardenTestApi {
  ready: boolean;
  plants: number;
  textures: number;
  frameStats(): {
    avgMs: number;
    p95Ms: number;
    cpuAvgMs: number;
    cpuP95Ms: number;
    frames: number;
  };
  resetFrameStats(): void;
  setZoom(level: ZoomLevel): void;
  zoomLevel(): ZoomLevel;
  /** Center a plant (by bed name + agent name) and return its canvas-relative client point. */
  focusPlant(
    bedName: string,
    agentName: string,
    level?: ZoomLevel,
  ): { x: number; y: number } | null;
  /** Client point of a bed's label plaque (by bed name), or null when hidden. */
  bedLabelPoint(bedName: string): { x: number; y: number } | null;
}

declare global {
  interface Window {
    __garden?: GardenTestApi;
  }
}

export interface GardenStageHandle {
  zoomBy(f: number): void;
  fit(): void;
  setZoom(level: ZoomLevel): void;
}

interface Props {
  view: GardenView;
  selectedId: ID | null;
  onSelect: (id: ID) => void;
  onZoomLevel: (z: ZoomLevel) => void;
  onBedLabel: (bedId: ID) => void;
}

export const GardenStage = forwardRef<GardenStageHandle, Props>(function GardenStage(
  { view, selectedId, onSelect, onZoomLevel, onBedLabel },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GardenRenderer | null>(null);
  const focusedRef = useRef<ID | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const cbRef = useRef({ onSelect, onZoomLevel, onBedLabel });
  cbRef.current = { onSelect, onZoomLevel, onBedLabel };

  const placeRing = () => {
    const r = rendererRef.current;
    const ring = ringRef.current;
    const id = focusedRef.current;
    if (!r || !ring) return;
    const rect = id ? r.plantScreenRect(id) : null;
    if (!rect || r.zoomLevel === 'far') {
      ring.style.display = 'none';
      return;
    }
    ring.style.display = 'block';
    ring.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    ring.style.width = `${rect.w}px`;
    ring.style.height = `${rect.h}px`;
  };

  const placeTip = (x: number, y: number) => {
    const tip = tipRef.current;
    const host = hostRef.current;
    if (!tip || !host) return;
    const hr = host.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x - hr.left + 16;
    let top = y - hr.top + 16;
    if (left + tw > hr.width - 8) left = x - hr.left - tw - 16;
    if (top + th > hr.height - 8) top = Math.max(8, hr.height - th - 8);
    tip.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
  };

  // Create the renderer once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const r = new GardenRenderer({
      onHover: (t, x, y) => {
        setHover((prev) => (prev && t && targetKey(prev) === targetKey(t) ? prev : t));
        if (t) requestAnimationFrame(() => placeTip(x, y));
      },
      onSelect: (t) => {
        if (t.kind === 'plant') cbRef.current.onSelect(t.id);
      },
      onZoomLevel: (z) => cbRef.current.onZoomLevel(z),
      onCamera: placeRing,
      onBedLabel: (id) => cbRef.current.onBedLabel(id),
    });
    rendererRef.current = r;
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    void Promise.all([
      r.init(host),
      fontsReady.then(() =>
        Promise.all([
          document.fonts.load('500 14px Fraunces'),
          document.fonts.load('600 11px "Source Sans 3"'),
          document.fonts.load('italic 400 8px "Source Sans 3"'),
        ]).catch(() => undefined),
      ),
    ]).then(() => {
      if (!cancelled) setReady(true);
    });
    const onMove = (e: PointerEvent) => placeTip(e.clientX, e.clientY);
    host.addEventListener('pointermove', onMove);
    return () => {
      cancelled = true;
      host.removeEventListener('pointermove', onMove);
      r.destroy();
      rendererRef.current = null;
      if (window.__garden) window.__garden.ready = false;
    };
  }, []);

  // Data → scene.
  useEffect(() => {
    const r = rendererRef.current;
    if (!ready || !r) return;
    r.setData(view);
    onZoomLevel(r.zoomLevel);
    const byName = (bedName: string, agentName: string) => {
      const bed = view.beds.find((b) => b.name === bedName);
      return view.plants.find((p) => p.bedId === bed?.id && p.name === agentName);
    };
    window.__garden = {
      ready: true,
      plants: view.plants.length,
      textures: r.textureCount,
      frameStats: () => r.frameStats(),
      resetFrameStats: () => r.resetFrameStats(),
      setZoom: (z) => r.setZoom(z),
      zoomLevel: () => r.zoomLevel,
      focusPlant: (bedName, agentName, level = 'near') => {
        const p = byName(bedName, agentName);
        const pp = p ? r.layout?.plants.get(p.id) : undefined;
        if (!pp) return null;
        r.centerOn(pp.x, pp.y - 30, level === 'far' ? 0.34 : level === 'mid' ? 0.85 : 1.9);
        const rect = r.plantScreenRect(p!.id)!;
        const hr = hostRef.current!.getBoundingClientRect();
        return { x: hr.left + rect.x + rect.w / 2, y: hr.top + rect.y + rect.h * 0.45 };
      },
      bedLabelPoint: (bedName) => {
        const bed = view.beds.find((b) => b.name === bedName);
        const pt = bed ? r.bedLabelScreenPoint(bed.id) : null;
        if (!pt) return null;
        const hr = hostRef.current!.getBoundingClientRect();
        return { x: hr.left + pt.x, y: hr.top + pt.y };
      },
    };
  }, [ready, view]);

  useEffect(() => {
    rendererRef.current?.setSelected(selectedId);
  }, [selectedId, ready, view]);

  useImperativeHandle(ref, () => ({
    zoomBy: (f) => rendererRef.current?.zoomBy(f),
    fit: () => rendererRef.current?.fit(),
    setZoom: (z) => rendererRef.current?.setZoom(z),
  }));

  const desc = hover ? describe(view, hover) : null;
  const order = rendererRef.current?.layout?.focusOrder ?? view.plants.map((p) => p.id);
  const plantById = new Map(view.plants.map((p) => [p.id, p]));
  const bedName = new Map(view.beds.map((b) => [b.id, b.name]));

  return (
    <div className="garden-stage">
      <div ref={hostRef} className="canvas-host" />
      <div ref={ringRef} className="focus-ring" aria-hidden="true" />
      <div className="sr-plants" role="list" aria-label="Plants (Tab to move, Enter to open)">
        {order.map((id) => {
          const p = plantById.get(id);
          if (!p) return null;
          return (
            <button
              key={id}
              type="button"
              role="listitem"
              className="sr-plant"
              aria-label={`${p.name} in ${bedName.get(p.bedId)}: ${p.runs} runs, success ${formatRate(p.success)}`}
              onFocus={() => {
                focusedRef.current = id;
                rendererRef.current?.ensureVisible(id);
                placeRing();
              }}
              onBlur={() => {
                focusedRef.current = null;
                placeRing();
              }}
              onClick={() => onSelect(id)}
            />
          );
        })}
      </div>
      <div ref={tipRef} className={`tooltip${desc ? ' show' : ''}`} role="tooltip">
        {desc ? <DescriptionBody d={desc} compact /> : null}
      </div>
    </div>
  );
});
