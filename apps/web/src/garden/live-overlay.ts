/**
 * Live overlay: imperative Pixi layer over the garden, driven by `LiveSnapshot`s (live-store.ts)
 * and the renderer's `GardenOverlay` hooks (scene, camera, ticker). Every mark is a registered
 * `live.*` encoding drawn with live-draw.ts; the model (which agent sits where, what each channel
 * shows) is the pure overlay-model.ts.
 *
 * Motion: bees fly on subagent start / end and a loop channel pulses once when a loop starts a run.
 * With prefers-reduced-motion, bees are placed directly and the pulse is a static 2 s highlight.
 */
import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { INK, type GardenView, type ID, type LiveSnapshot } from '@garden/core';
import { truncate } from '../format';
import {
  anchorKey,
  anchorFor,
  fillOf,
  isCompactionCut,
  liveBees,
  newLoopRuns,
  overlayMarks,
  type LiveMark,
} from '../live/overlay-model';
import type { GardenLayout, Pt } from './layout';
import { freeSlots } from './live-layout';
import {
  drawActivityGlyph,
  drawAttentionTag,
  drawChannelLit,
  drawCompactionCut,
  drawCountPips,
  drawErrorTicks,
  drawLiveBee,
  drawLiveRing,
  drawNewFlag,
  drawPulseSegment,
  drawSeedling,
  RING,
  TAG,
} from './live-draw';
import type { GardenOverlay, ZoomLevel } from './renderer';

const FLIGHT_MS = 1400;
const PULSE_MS = 1700;
const PULSE_STATIC_MS = 2000;
const CUT_MS = 3200;
const FONT_UI = '"Source Sans 3", "Source Sans Pro", system-ui, sans-serif';
const TEXT_RES = Math.min(4, Math.max(2, (globalThis.devicePixelRatio ?? 1) * 2));

interface AnchorPos {
  /** Plant base (ring center). */
  base: Pt;
  /** Tag center. */
  tag: Pt;
  seedling: boolean;
}

interface BeeAnim {
  from: string;
  to: string;
  t: number;
  phase: 'out' | 'hover' | 'back';
}

export interface LiveOverlayStats {
  marks: number;
  seedlings: number;
  attention: { key: string; reason: string; inferred: boolean }[];
  bees: { key: string; phase: 'out' | 'hover' | 'back' }[];
  pulsesFired: number;
  cuts: number;
  reducedMotion: boolean;
  visible: boolean;
}

export class LiveOverlay implements GardenOverlay {
  readonly container = new Container();
  private pulseG = new Graphics();
  private ringG = new Graphics();
  private beeG = new Graphics();
  private tagG = new Graphics();
  private labels = new Container();
  private view: GardenView | null = null;
  private layout: GardenLayout | null = null;
  private snap: LiveSnapshot | null = null;
  private marks: LiveMark[] = [];
  private pos = new Map<string, AnchorPos>();
  private seedSlots = new Map<string, number>();
  private bees = new Map<ID, BeeAnim>();
  private pulses = new Map<ID, number>();
  private cuts = new Map<ID, { anchor: string; at: number; until: number }>();
  private prevFill = new Map<ID, number>();
  private seen = new Set<ID>();
  private primed = false;
  private clock = 0;
  private scale = 1;
  private zoom: ZoomLevel = 'mid';
  private reduced = false;
  private dirty = true;
  private pulsesFired = 0;

  constructor() {
    this.container.eventMode = 'none';
    this.container.interactiveChildren = false;
    this.container.addChild(this.pulseG, this.ringG, this.beeG, this.tagG, this.labels);
  }

  // ---- GardenOverlay -----------------------------------------------------------------------

  setScene(view: GardenView, layout: GardenLayout): void {
    this.view = view;
    this.layout = layout;
    this.seedSlots.clear();
    this.rebuild(false);
  }

  camera(scale: number, zoom: ZoomLevel): void {
    if (scale !== this.scale) this.dirty = true;
    this.scale = scale;
    this.zoom = zoom;
    this.container.visible = zoom !== 'far' && this.snap !== null;
  }

  tick(deltaMS: number, reducedMotion: boolean): void {
    if (reducedMotion !== this.reduced) {
      this.reduced = reducedMotion;
      if (reducedMotion) this.settleMotion();
      this.dirty = true;
    }
    this.clock += deltaMS;
    let animating = false;
    for (const [key, b] of this.bees) {
      if (b.phase === 'hover') continue;
      animating = true;
      const dt = deltaMS / FLIGHT_MS;
      if (b.phase === 'out') {
        b.t = Math.min(1, b.t + dt);
        if (b.t >= 1) b.phase = 'hover';
      } else {
        b.t = Math.max(0, b.t - dt);
        if (b.t <= 0) this.bees.delete(key);
      }
    }
    for (const [id, t0] of this.pulses) {
      const life = this.reduced ? PULSE_STATIC_MS : PULSE_MS;
      if (this.clock - t0 > life) this.pulses.delete(id);
      else animating = true;
    }
    for (const [k, c] of this.cuts) {
      if (this.clock > c.until) {
        this.cuts.delete(k);
        this.dirty = true;
      } else if (!this.reduced) animating = true;
    }
    if (animating || this.dirty) this.draw();
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  // ---- data --------------------------------------------------------------------------------

  setSnapshot(snap: LiveSnapshot | null): void {
    this.snap = snap;
    this.container.visible = this.zoom !== 'far' && snap !== null;
    this.rebuild(true);
  }

  private settleMotion(): void {
    for (const [key, b] of this.bees) {
      if (b.phase === 'out') {
        b.phase = 'hover';
        b.t = 1;
      } else if (b.phase === 'back') this.bees.delete(key);
    }
  }

  private rebuild(fromStream: boolean): void {
    const view = this.view;
    const layout = this.layout;
    const snap = this.snap;
    this.dirty = true;
    if (!view || !layout || !snap) {
      this.marks = [];
      this.bees.clear();
      this.rebuildLabels();
      this.draw();
      return;
    }
    const { marks } = overlayMarks(view, snap);
    this.marks = marks;

    // Anchor positions: plants from the layout; seedlings take stable free slots in their bed.
    const live = new Set(marks.map((m) => m.key));
    for (const k of [...this.seedSlots.keys()]) if (!live.has(k)) this.seedSlots.delete(k);
    this.pos.clear();
    const seedsByBed = new Map<ID, string[]>();
    for (const m of marks) {
      if (m.anchor.kind === 'plant') {
        const pp = layout.plants.get(m.anchor.plantId);
        if (!pp) continue;
        this.pos.set(m.key, {
          base: { x: pp.x, y: pp.y + RING.dy },
          tag: { x: pp.x, y: pp.topY },
          seedling: false,
        });
      } else {
        seedsByBed.set(m.anchor.bedId, [...(seedsByBed.get(m.anchor.bedId) ?? []), m.key]);
      }
    }
    for (const [bedId, keys] of seedsByBed) {
      const used = new Set<number>();
      for (const k of keys) {
        const i = this.seedSlots.get(k);
        if (i !== undefined) used.add(i);
      }
      for (const k of [...keys].sort()) {
        if (this.seedSlots.has(k)) continue;
        let i = 0;
        while (used.has(i)) i++;
        used.add(i);
        this.seedSlots.set(k, i);
      }
      const max = Math.max(...keys.map((k) => this.seedSlots.get(k)!)) + 1;
      const spots = freeSlots(layout, bedId, max);
      for (const k of keys) {
        const p = spots[this.seedSlots.get(k)!]!;
        this.pos.set(k, {
          base: { x: p.x, y: p.y + RING.dy },
          tag: { x: p.x, y: p.y - 16 },
          seedling: true,
        });
      }
    }

    // Bees: start, hover, return.
    const specs = liveBees(view, snap);
    const wanted = new Set(specs.map((b) => b.key));
    for (const b of specs) {
      const cur = this.bees.get(b.key);
      if (!cur) {
        if (b.returning) continue;
        const direct = this.reduced || !this.primed || !fromStream;
        this.bees.set(b.key, {
          from: b.from,
          to: b.to,
          t: direct ? 1 : 0,
          phase: direct ? 'hover' : 'out',
        });
      } else if (b.returning && cur.phase !== 'back') {
        if (this.reduced) this.bees.delete(b.key);
        else cur.phase = 'back';
      }
    }
    for (const [key, b] of this.bees) {
      if (wanted.has(key) || b.phase === 'back') continue;
      if (this.reduced) this.bees.delete(key);
      else b.phase = 'back';
    }

    // Loop pulses (not for agents already present when the overlay first saw the stream).
    const fired = newLoopRuns(view, snap, this.seen);
    if (this.primed && fromStream)
      for (const id of fired) {
        this.pulses.set(id, this.clock);
        this.pulsesFired++;
      }

    // Compaction cuts.
    const anchorOf = new Map<ID, string>();
    for (const m of marks) for (const a of m.agents) anchorOf.set(a.key, m.key);
    for (const a of snap.agents) {
      const prev = this.prevFill.get(a.key);
      const k = anchorOf.get(a.key);
      if (k && isCompactionCut(prev, a)) {
        const cur = this.cuts.get(a.key);
        this.cuts.set(a.key, {
          anchor: k,
          at: cur ? cur.at : (prev ?? fillOf(a)),
          until: this.clock + CUT_MS,
        });
      }
      this.prevFill.set(a.key, fillOf(a));
    }
    for (const key of [...this.prevFill.keys()])
      if (!snap.agents.some((a) => a.key === key)) {
        this.prevFill.delete(key);
        this.cuts.delete(key);
      }

    this.seen = new Set([...this.seen].filter((k) => snap.agents.some((a) => a.key === k)));
    for (const a of snap.agents) this.seen.add(a.key);
    if (fromStream) this.primed = true;
    this.rebuildLabels();
    this.draw();
  }

  private rebuildLabels(): void {
    for (const c of this.labels.removeChildren()) c.destroy();
    const k = this.counter();
    for (const m of this.marks) {
      if (m.anchor.kind !== 'seedling') continue;
      const p = this.pos.get(m.key);
      if (!p) continue;
      const g = new Graphics();
      drawSeedling(g, p.base.x, p.base.y - RING.dy);
      drawNewFlag(g, p.base.x - 37, p.base.y - 8, 24);
      this.labels.addChild(g);
      const t = new Text({
        text: 'new',
        style: new TextStyle({
          fontFamily: FONT_UI,
          fontSize: 8.5,
          fontWeight: '600',
          fill: INK.primary,
        }),
        resolution: TEXT_RES,
      });
      t.anchor.set(0.5);
      t.position.set(p.base.x - 25, p.base.y - 8);
      this.labels.addChild(t);
      const name = new Text({
        text: truncate(m.anchor.agentName, 18),
        style: new TextStyle({
          fontFamily: FONT_UI,
          fontSize: 10 * Math.min(1.6, k),
          fontStyle: 'italic',
          fill: INK.secondary,
        }),
        resolution: TEXT_RES,
      });
      name.anchor.set(0.5, 0);
      name.position.set(p.base.x, p.base.y + RING.ry + 3);
      this.labels.addChild(name);
    }
  }

  /** Tags and bees keep a legible size when zoomed out (like the bed plaques). */
  private counter(): number {
    return Math.min(2.4, Math.max(1, 1.1 / this.scale));
  }

  /** Line widths keep at least ~1 screen px when zoomed out. */
  private lineK(): number {
    return Math.min(2, Math.max(1, 0.85 / this.scale));
  }

  /** Tag center: to the right of the plant's top, clear of its flowers. */
  private tagAt(p: AnchorPos, k: number): Pt {
    return { x: p.tag.x + 14 + TAG.r * k, y: p.tag.y + 2 };
  }

  // ---- drawing -----------------------------------------------------------------------------

  private draw(): void {
    this.dirty = false;
    const k = this.counter();
    const lk = this.lineK();
    for (const g of [this.pulseG, this.ringG, this.beeG, this.tagG]) g.clear();
    if (!this.snap) return;

    // Loop pulses along their channels.
    if (this.layout)
      for (const [loopId, t0] of this.pulses) {
        const route = this.layout.loops.find((r) => r.loopId === loopId);
        if (!route) continue;
        const age = this.clock - t0;
        for (const path of route.paths) {
          if (this.reduced) {
            drawChannelLit(this.pulseG, path, 1 - age / PULSE_STATIC_MS);
            continue;
          }
          let L = 0;
          for (let i = 0; i + 1 < path.length; i++)
            L += Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.y - path[i]!.y);
          const f = age / PULSE_MS;
          drawPulseSegment(this.pulseG, path, f * (L + 40), 40, f > 0.85 ? (1 - f) / 0.15 : 1);
        }
      }

    // Rings, error ticks, compaction cuts.
    for (const m of this.marks) {
      const p = this.pos.get(m.key);
      if (!p) continue;
      const { x, y } = p.base;
      const rx = p.seedling ? RING.rx * 0.7 : RING.rx;
      const ry = p.seedling ? RING.ry * 0.8 : RING.ry;
      drawLiveRing(this.ringG, x, y, m.fill, m.ringLevel, rx, ry, lk);
      if (m.errors > 0) drawErrorTicks(this.ringG, x, y, m.errors, m.errored, rx, ry, lk);
    }
    for (const c of this.cuts.values()) {
      const p = this.pos.get(c.anchor);
      if (!p) continue;
      const left = (c.until - this.clock) / CUT_MS;
      const rx = p.seedling ? RING.rx * 0.7 : RING.rx;
      const ry = p.seedling ? RING.ry * 0.8 : RING.ry;
      drawCompactionCut(
        this.ringG,
        p.base.x,
        p.base.y,
        c.at,
        this.reduced ? 1 : Math.min(1, left * 2),
        rx,
        ry,
      );
    }

    // Bees.
    for (const b of this.bees.values()) {
      const a = this.pos.get(b.from);
      const c = this.pos.get(b.to);
      if (!a || !c) continue;
      const from = { x: a.tag.x, y: a.tag.y };
      const to = { x: c.tag.x - 12 - 6 * k, y: c.tag.y - 2 };
      drawLiveBee(this.beeG, from, to, b.t, b.phase, 1.45 * Math.min(1.6, k));
    }

    // Tags (activity or attention) and count pips.
    for (const m of this.marks) {
      const p = this.pos.get(m.key);
      if (!p) continue;
      const { x, y } = this.tagAt(p, m.attention ? k * 1.2 : k);
      if (m.attention)
        drawAttentionTag(this.tagG, x, y, m.attention.reason, m.attention.inferred, k);
      else if (m.glyph) drawActivityGlyph(this.tagG, x, y, m.glyph, k);
      if (m.count > 1 && (m.attention || m.glyph))
        drawCountPips(this.tagG, x + (m.attention ? 13.5 : 11.5) * k, y, m.count);
    }
  }

  // ---- test / debug ------------------------------------------------------------------------

  stats(): LiveOverlayStats {
    return {
      marks: this.marks.length,
      seedlings: this.marks.filter((m) => m.anchor.kind === 'seedling').length,
      attention: this.marks
        .filter((m) => m.attention)
        .map((m) => ({ key: m.key, reason: m.attention!.reason, inferred: m.attention!.inferred })),
      bees: [...this.bees].map(([key, b]) => ({ key, phase: b.phase })),
      pulsesFired: this.pulsesFired,
      cuts: this.cuts.size,
      reducedMotion: this.reduced,
      visible: this.container.visible,
    };
  }

  /** Anchor (plant id or seedling key) of a live agent, if it is on the canvas. */
  anchorOf(agentKey: ID): string | null {
    const a = this.snap?.agents.find((x) => x.key === agentKey);
    if (!a || !this.view) return null;
    const anc = anchorFor(a, this.view);
    return anc.kind === 'offstage' ? null : anchorKey(anc);
  }
}
