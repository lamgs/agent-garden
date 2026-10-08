/**
 * Imperative PixiJS garden renderer. React hosts it but never sees per-frame state: animation,
 * camera, and hit-testing live here; React gets coarse callbacks (hover target changed, select,
 * zoom level changed, camera moved).
 */
import 'pixi.js/unsafe-eval';
import {
  Application,
  CullerPlugin,
  extensions,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  UPDATE_PRIORITY,
  type FederatedPointerEvent,
  type Texture,
} from 'pixi.js';
import {
  beeCount,
  bedStrata,
  bedStrataShares,
  bedStrataWeight,
  bedTexture,
  bedTone,
  careCardSize,
  HIGHLIGHT,
  INK,
  irrigationFlow,
  irrigationState,
  PAPER,
  plantBloom,
  playbookGate,
  SOIL,
  WATER,
  weedKind,
  type GardenView,
  type ID,
} from '@garden/core';
import type { HoverTarget } from '../describe';
import { bedAggregate } from '../describe';
import { bedLabel, formatInt, pct, truncate } from '../format';
import {
  BED_FACE,
  BLOOM_FLOWERS,
  BLOOM_OPENNESS,
  drawBed,
  drawBee,
  drawChannel,
  drawFlow,
  drawFlower,
  drawGate,
  drawHollowBud,
  drawIcon,
  drawPacket,
  drawPlant,
  drawPuddle,
  drawStone,
  drawWeed,
  dashPolyline,
  FLOW_SPEED,
  hashString,
  PLANT_FRAME,
  pointAlong,
  polylineLength,
  STEM_LENGTH,
} from './draw';
import { GenotypeCache, genotypeKey, genotypeOf } from './genotype';
import { drawBadge, drawGlow } from './highlight';
import { beeArc, beePoint, computeLayout, type GardenLayout, type Pt } from './layout';
import { familyTone } from './swatches';

export type ZoomLevel = 'far' | 'mid' | 'near';
export const ZOOM_SCALE: Record<ZoomLevel, number> = { far: 0.5, mid: 0.85, near: 1.8 };
export const FAR_BELOW = 0.55;
export const NEAR_FROM = 1.4;
export function zoomLevelFor(scale: number): ZoomLevel {
  return scale < FAR_BELOW ? 'far' : scale >= NEAR_FROM ? 'near' : 'mid';
}

/**
 * A layer another module draws above the plants (e.g. the live overlay, garden/live-overlay.ts).
 * The renderer owns the scene and the ticker; the overlay only gets the scene, the camera, and time.
 * Overlays are not dimmed by the router highlight.
 */
export interface GardenOverlay {
  readonly container: Container;
  setScene(view: GardenView, layout: GardenLayout): void;
  camera(scale: number, zoom: ZoomLevel): void;
  tick(deltaMS: number, reducedMotion: boolean): void;
  destroy?(): void;
}

export interface RendererCallbacks {
  onHover: (t: HoverTarget | null, clientX: number, clientY: number) => void;
  onSelect: (t: HoverTarget) => void;
  onZoomLevel: (z: ZoomLevel) => void;
  onCamera: () => void;
  /** A bed's label plaque was clicked (opens the "Compare beds" picker). */
  onBedLabel?: (bedId: ID) => void;
}

const FONT_UI = '"Source Sans 3", "Source Sans Pro", system-ui, sans-serif';
const FONT_SERIF = 'Fraunces, Georgia, serif';
const TEXT_RES = Math.min(4, Math.max(2, (globalThis.devicePixelRatio ?? 1) * 2));

interface PlantNode {
  id: ID;
  sprite: Sprite;
  phase: number;
}
interface BeeNode {
  sprite: Sprite;
  route: { p0: Pt; c: Pt; p1: Pt };
  offset: number;
  speed: number;
}
interface FlowNode {
  paths: Pt[][];
  level: number;
}

export class GardenRenderer {
  readonly app = new Application();
  private host!: HTMLElement;
  private world = new Container();
  private layers = {
    beds: new Container(),
    water: new Container(),
    flow: new Graphics(),
    playbook: new Container(),
    plants: new Container(),
    weeds: new Container(),
    bees: new Container(),
    markers: new Container(),
    near: new Container(),
    plaques: new Container(),
    far: new Container(),
    focus: new Graphics(),
  };
  private textures = new GenotypeCache<Texture>();
  private beeTexture: Texture | null = null;
  private plantNodes: PlantNode[] = [];
  private beeNodes: BeeNode[] = [];
  private flowNodes: FlowNode[] = [];
  private counterScaled: { obj: Container; base: number; max: number }[] = [];
  private view: GardenView | null = null;
  layout: GardenLayout | null = null;
  private zoom: ZoomLevel = 'mid';
  private reducedMotion = false;
  private dragging = false;
  private dragMoved = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private hovered: HoverTarget | null = null;
  private frameMs: number[] = [];
  private cpuMs: number[] = [];
  private frameStart = 0;
  private time = 0;
  private destroyed = false;
  private plaqueByBed = new Map<ID, Container>();
  private cleanup: (() => void)[] = [];
  private overlays: GardenOverlay[] = [];
  private overlayLayer = new Container();
  /** Router highlight (encoding router.highlight): glows under plants, badges on top. */
  private hl = {
    under: new Container(),
    over: new Container(),
    ids: [] as ID[],
    badges: {} as Readonly<Record<ID, string>>,
  };

  constructor(private readonly cb: RendererCallbacks) {}

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    extensions.add(CullerPlugin);
    await this.app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(2, globalThis.devicePixelRatio ?? 1),
      preference: 'webgl',
    });
    if (this.destroyed) return;
    const canvas = this.app.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);
    const L = this.layers;
    this.world.addChild(
      L.beds,
      L.water,
      L.flow,
      L.playbook,
      L.focus,
      this.hl.under,
      L.plants,
      L.weeds,
      L.markers,
      L.bees,
      this.overlayLayer,
      L.near,
      L.plaques,
      L.far,
      this.hl.over,
    );
    this.app.stage.addChild(this.world);
    this.app.stage.eventMode = 'static';

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = mq.matches;
    const onMq = () => {
      this.reducedMotion = mq.matches;
      this.resetMotion();
    };
    mq.addEventListener('change', onMq);
    this.cleanup.push(() => mq.removeEventListener('change', onMq));

    this.bindPointer(canvas);
    this.app.ticker.add(
      () => (this.frameStart = performance.now()),
      undefined,
      UPDATE_PRIORITY.HIGH,
    );
    this.app.ticker.add((t) => this.tick(t.deltaMS), undefined, UPDATE_PRIORITY.NORMAL);
    this.app.ticker.add(
      (t) => {
        this.push(this.frameMs, t.deltaMS);
        this.push(this.cpuMs, performance.now() - this.frameStart);
      },
      undefined,
      UPDATE_PRIORITY.UTILITY,
    );
  }

  private push(buf: number[], v: number) {
    buf.push(v);
    if (buf.length > 1200) buf.shift();
  }

  frameStats(): {
    avgMs: number;
    p95Ms: number;
    cpuAvgMs: number;
    cpuP95Ms: number;
    frames: number;
  } {
    const stat = (xs: number[]) => {
      if (!xs.length) return { avg: 0, p95: 0 };
      const s = [...xs].sort((a, b) => a - b);
      return {
        avg: xs.reduce((a, b) => a + b, 0) / xs.length,
        p95: s[Math.floor(s.length * 0.95)] ?? 0,
      };
    };
    const f = stat(this.frameMs);
    const c = stat(this.cpuMs);
    return {
      avgMs: f.avg,
      p95Ms: f.p95,
      cpuAvgMs: c.avg,
      cpuP95Ms: c.p95,
      frames: this.frameMs.length,
    };
  }

  resetFrameStats(): void {
    this.frameMs = [];
    this.cpuMs = [];
  }

  get textureCount(): number {
    return this.textures.size;
  }

  // ---- data → scene ----------------------------------------------------------------------

  setData(view: GardenView): void {
    this.view = view;
    const layout = computeLayout(view);
    this.layout = layout;
    for (const layer of Object.values(this.layers)) {
      if (layer instanceof Graphics) layer.clear();
      else for (const c of layer.removeChildren()) c.destroy({ children: true });
    }
    this.plantNodes = [];
    this.beeNodes = [];
    this.flowNodes = [];
    this.counterScaled = [];
    this.plaqueByBed.clear();
    this.buildBeds(view, layout);
    this.buildWater(view, layout);
    this.buildPlaybooks(view, layout);
    this.buildPlants(view, layout);
    this.buildWeeds(view, layout);
    this.buildBees(view, layout);
    this.buildNear(view, layout);
    this.buildFar(view, layout);
    this.fit();
    this.highlight(this.hl.ids, this.hl.badges);
    for (const o of this.overlays) o.setScene(view, layout);
  }

  /** Attach an overlay layer; returns a detach function. */
  addOverlay(o: GardenOverlay): () => void {
    this.overlays.push(o);
    this.overlayLayer.addChild(o.container);
    if (this.view && this.layout) o.setScene(this.view, this.layout);
    o.camera(this.scale, this.zoom);
    return () => {
      this.overlays = this.overlays.filter((x) => x !== o);
      this.overlayLayer.removeChild(o.container);
    };
  }

  private interactive(obj: Container, target: HoverTarget, hit?: Rectangle): void {
    obj.eventMode = 'static';
    obj.cursor = 'pointer';
    if (hit) obj.hitArea = hit;
    obj.on('pointerover', (e: FederatedPointerEvent) => {
      if (this.dragging && this.dragMoved) return;
      // Pixi tracks moves on the document; ignore hovers through DOM overlays (panels, toolbar).
      if (e.nativeEvent && e.nativeEvent.target !== this.app.canvas) return;
      this.hovered = target;
      this.cb.onHover(target, e.clientX, e.clientY);
    });
    obj.on('pointerout', (e: FederatedPointerEvent) => {
      if (this.hovered === target) {
        this.hovered = null;
        this.cb.onHover(null, e.clientX, e.clientY);
      }
    });
    obj.on('pointertap', () => {
      if (!this.dragMoved) this.cb.onSelect(target);
    });
  }

  private text(
    s: string,
    size: number,
    opts: Partial<{ serif: boolean; color: string; weight: string; italic: boolean }> = {},
  ): Text {
    const t = new Text({
      text: s,
      style: new TextStyle({
        fontFamily: opts.serif ? FONT_SERIF : FONT_UI,
        fontSize: size,
        fill: opts.color ?? INK.primary,
        fontWeight: (opts.weight ?? '400') as TextStyle['fontWeight'],
        fontStyle: opts.italic ? 'italic' : 'normal',
      }),
      resolution: TEXT_RES,
    });
    return t;
  }

  private buildBeds(view: GardenView, layout: GardenLayout): void {
    for (const bp of layout.beds) {
      const bed = view.beds.find((b) => b.id === bp.bedId)!;
      const g = new Graphics();
      drawBed(
        g,
        bp.x,
        bp.y,
        bp.w,
        bp.h,
        {
          tone: familyTone(bedTone.level(bed)),
          texture: bedTexture.level(bed),
          strata: bedStrata.level(bed),
          // Knowledge map (K): one band per always-loaded layer, ink weight = total tokens.
          bands: bedStrataShares(bed),
          weight: bedStrataWeight.level(bed),
        },
        hashString(bed.id),
      );
      this.interactive(g, { kind: 'bed', id: bed.id }, new Rectangle(bp.x, bp.y, bp.w, bp.h));
      this.layers.beds.addChild(g);

      // Direct label on the front face: edging colors are < 3:1, so the text carries identity.
      const plaque = new Container();
      const label = this.text(bedLabel(bed), 14, { serif: true, weight: '500' });
      const chip = new Graphics();
      chip.roundRect(0, 0, 10, 10, 2).fill({ color: familyTone(bedTone.level(bed)) });
      chip.stroke({ color: INK.primary, width: 0.8, alpha: 0.6 });
      const pw = label.width + 30;
      const bg = new Graphics();
      bg.roundRect(0, 0, pw, 21, 3).fill({ color: PAPER });
      bg.stroke({ color: INK.primary, width: 1, alpha: 0.55 });
      chip.position.set(8, 5.5);
      label.position.set(23, 1.5);
      plaque.addChild(bg, chip, label);
      plaque.position.set(bp.x + 12, bp.y + bp.h - BED_FACE - 1);
      this.interactive(plaque, { kind: 'bed', id: bed.id });
      plaque.on('pointertap', () => {
        if (!this.dragMoved) this.cb.onBedLabel?.(bed.id);
      });
      this.plaqueByBed.set(bed.id, plaque);
      this.layers.plaques.addChild(plaque);
      this.counterScaled.push({ obj: plaque, base: 0.95, max: 1.5 });
    }
    if (layout.compost) {
      const c = layout.compost;
      const g = new Graphics();
      g.roundRect(c.x, c.y, c.w, c.h, 6).fill({ color: SOIL.fill });
      for (let x = c.x + 10; x < c.x + c.w - 4; x += 12) {
        g.moveTo(x, c.y + 4).lineTo(x, c.y + c.h - 4);
      }
      g.stroke({ color: SOIL.rim, width: 1, alpha: 0.6 });
      g.roundRect(c.x, c.y, c.w, c.h, 6).stroke({ color: INK.primary, width: 1.2, alpha: 0.55 });
      this.layers.beds.addChild(g);
      const t1 = this.text('Compost corner', 14, { serif: true, weight: '500' });
      const t2 = this.text('weeds not tied to one bed', 10, { color: INK.secondary, italic: true });
      const bg = new Graphics();
      bg.roundRect(0, 0, Math.max(t1.width, t2.width) + 14, 34, 3).fill({ color: PAPER });
      bg.stroke({ color: INK.primary, width: 1, alpha: 0.5 });
      t1.position.set(7, 1);
      t2.position.set(7, 19);
      const plaque = new Container();
      plaque.addChild(bg, t1, t2);
      plaque.position.set(c.x + 8, c.y + 8);
      this.layers.plaques.addChild(plaque);
    }
  }

  private buildWater(view: GardenView, layout: GardenLayout): void {
    for (const route of layout.loops) {
      const loop = view.loops.find((l) => l.loopId === route.loopId)!;
      const flow = irrigationFlow.level(loop);
      const state = irrigationState.level(loop);
      const g = new Graphics();
      for (const path of route.paths) drawChannel(g, path, flow, state, loop.observed !== false);
      for (const s of route.sources) {
        g.circle(s.x, s.y, 4.5).fill({ color: state === 2 ? SOIL.fill : WATER.flow });
        g.stroke({ color: INK.primary, width: 1, alpha: 0.6 });
      }
      const box = new Container();
      box.addChild(g);
      // invisible hit strips along each segment
      for (const path of route.paths) {
        for (let i = 0; i + 1 < path.length; i++) {
          const a = path[i]!;
          const b = path[i + 1]!;
          const hit = new Container();
          const pad = 5;
          this.interactive(
            hit,
            { kind: 'loop', id: loop.loopId },
            new Rectangle(
              Math.min(a.x, b.x) - pad,
              Math.min(a.y, b.y) - pad,
              Math.abs(b.x - a.x) + pad * 2,
              Math.abs(b.y - a.y) + pad * 2,
            ),
          );
          box.addChild(hit);
        }
      }
      this.layers.water.addChild(box);
      if (state !== 2 && loop.observed !== false)
        this.flowNodes.push({ paths: route.paths, level: flow });

      // Flooding: overflow puddle at each target + icon + label. Dry: icon + label.
      if (state > 0) {
        const m = new Graphics();
        if (state === 1) for (const e of route.ends) drawPuddle(m, e.x - 4, e.y + 7, 15);
        this.layers.markers.addChild(m);
        const first = route.ends[0];
        if (first) {
          const plaque = new Container();
          const icon = new Graphics();
          drawIcon(icon, 9, 10.5, state === 1 ? 'flood' : 'dry', 1.05);
          const word = state === 1 ? 'Flooding' : 'Dry';
          const t = this.text(`${word} · ${truncate(loop.name, 34)}`, 11.5, { weight: '600' });
          const bg = new Graphics();
          bg.roundRect(0, 0, t.width + 26, 21, 10).fill({ color: PAPER });
          bg.stroke({ color: INK.primary, width: 1, alpha: 0.5 });
          t.position.set(20, 3);
          plaque.addChild(bg, icon, t);
          plaque.position.set(first.dropTop.x + 6, first.dropTop.y - 24);
          this.interactive(plaque, { kind: 'loop', id: loop.loopId });
          this.layers.markers.addChild(plaque);
          this.counterScaled.push({ obj: plaque, base: 0.9, max: 2.4 });
        }
      }
    }
  }

  private buildPlaybooks(view: GardenView, layout: GardenLayout): void {
    for (const route of layout.playbooks) {
      const pb = view.playbooks.find((p) => p.id === route.playbookId)!;
      const g = new Graphics();
      const L = polylineLength(route.path);
      for (let d = 0; d <= L; d += 9) {
        const p = pointAlong(route.path, d);
        if (route.gates.some((gt) => Math.abs(gt.x - p.x) < 9 && Math.abs(gt.y - p.y) < 6))
          continue;
        drawStone(g, p.x, p.y + 1, 3.4);
      }
      this.layers.playbook.addChild(g);
      for (const gate of route.gates) {
        const step = pb.steps[gate.stepIndex]!;
        const gg = new Graphics();
        drawGate(gg, gate.x, gate.y + 2, playbookGate.level(step));
        this.interactive(
          gg,
          { kind: 'gate', playbookId: pb.id, stepIndex: gate.stepIndex },
          new Rectangle(gate.x - 12, gate.y - 18, 34, 22),
        );
        this.layers.playbook.addChild(gg);
      }
      const t = this.text(`Playbook: ${pb.name}`, 9.5, { italic: true, color: INK.secondary });
      const gx = route.gates.map((gt) => gt.x);
      t.anchor.set(0.5, 0);
      t.position.set((Math.min(...gx) + Math.max(...gx)) / 2, route.start.y + 5);
      this.layers.playbook.addChild(t);
    }
  }

  private plantTexture(key: string, make: () => Graphics): Texture {
    return this.textures.get(key, () => {
      const g = make();
      const tex = this.app.renderer.generateTexture({
        target: g,
        frame: new Rectangle(PLANT_FRAME.x, PLANT_FRAME.y, PLANT_FRAME.w, PLANT_FRAME.h),
        resolution: this.textures.size > 120 ? 1.5 : 2,
        antialias: true,
      });
      g.destroy();
      return tex;
    });
  }

  private buildPlants(view: GardenView, layout: GardenLayout): void {
    for (const p of view.plants) {
      const pp = layout.plants.get(p.id);
      if (!pp) continue;
      const g = genotypeOf(p);
      const tex = this.plantTexture(genotypeKey(g), () => {
        const gr = new Graphics();
        drawPlant(gr, g);
        return gr;
      });
      const s = new Sprite(tex);
      s.anchor.set(-PLANT_FRAME.x / PLANT_FRAME.w, -PLANT_FRAME.y / PLANT_FRAME.h);
      s.position.set(pp.x, pp.y);
      const h = hashString(p.id);
      if (h % 2 === 1) s.scale.x = -1;
      const top = STEM_LENGTH[g.height] ?? 20;
      this.interactive(s, { kind: 'plant', id: p.id }, new Rectangle(-24, -top - 14, 48, top + 20));
      s.cullable = true;
      this.layers.plants.addChild(s);
      this.plantNodes.push({ id: p.id, sprite: s, phase: (h % 1000) / 159 });
    }
  }

  private buildWeeds(view: GardenView, layout: GardenLayout): void {
    for (const wp of layout.weeds) {
      const w = view.weeds.find((x) => x.id === wp.weedId)!;
      const g = new Graphics();
      drawWeed(g, wp.x, wp.y, weedKind.level(w), 1.35);
      this.interactive(g, { kind: 'weed', id: w.id }, new Rectangle(wp.x - 11, wp.y - 26, 24, 28));
      this.layers.weeds.addChild(g);
    }
  }

  private buildBees(view: GardenView, layout: GardenLayout): void {
    if (!this.beeTexture) {
      const g = new Graphics();
      drawBee(g, 0, 0, 1.25);
      this.beeTexture = this.app.renderer.generateTexture({
        target: g,
        frame: new Rectangle(-6, -6, 12, 10),
        resolution: 4,
        antialias: true,
      });
      g.destroy();
    }
    for (const r of layout.bees) {
      const flow = view.bees.find(
        (b) => b.fromPlantId === r.fromPlantId && b.toPlantId === r.toPlantId,
      )!;
      const n = beeCount.level(flow) + 1;
      const arc = beeArc(r);
      const g = new Graphics();
      dashPolyline(g, arc, 1.6, 3.4);
      g.stroke({ color: INK.muted, width: 0.9, alpha: 0.75 });
      const box = new Container();
      box.addChild(g);
      for (let i = 0; i + 1 < arc.length; i += 2) {
        const a = arc[i]!;
        const b = arc[Math.min(arc.length - 1, i + 2)]!;
        const hit = new Container();
        this.interactive(
          hit,
          { kind: 'bee', from: r.fromPlantId, to: r.toPlantId },
          new Rectangle(
            Math.min(a.x, b.x) - 5,
            Math.min(a.y, b.y) - 5,
            Math.abs(b.x - a.x) + 10,
            Math.abs(b.y - a.y) + 10,
          ),
        );
        box.addChild(hit);
      }
      this.layers.bees.addChild(box);
      for (let k = 0; k < n; k++) {
        const s = new Sprite(this.beeTexture);
        s.anchor.set(0.5, 0.6);
        s.eventMode = 'none';
        const node: BeeNode = {
          sprite: s,
          route: r,
          offset: (k + 1) / (n + 1),
          speed: 0.11 + (hashString(r.fromPlantId + r.toPlantId) % 7) * 0.006,
        };
        this.placeBee(node, node.offset);
        this.layers.bees.addChild(s);
        this.beeNodes.push(node);
      }
    }
  }

  private placeBee(node: BeeNode, t: number): void {
    const p = beePoint(node.route, t);
    const q = beePoint(node.route, Math.min(1, t + 0.01));
    node.sprite.position.set(p.x, p.y + Math.sin(t * 40) * (this.reducedMotion ? 0 : 1.2));
    node.sprite.scale.x = q.x >= p.x ? 1 : -1;
  }

  private buildNear(view: GardenView, layout: GardenLayout): void {
    const skillsByPlant = new Map<ID, typeof view.skills>();
    for (const s of view.skills)
      skillsByPlant.set(s.plantId, [...(skillsByPlant.get(s.plantId) ?? []), s]);
    for (const p of view.plants) {
      const pp = layout.plants.get(p.id);
      if (!pp) continue;
      const name = this.text(truncate(p.name, 16), 11, { weight: '600' });
      name.anchor.set(0.5, 0);
      name.position.set(pp.x, pp.y + 22);
      this.layers.near.addChild(name);
      const cards = [...(skillsByPlant.get(p.id) ?? [])].sort(
        (a, b) => b.invocations - a.invocations,
      );
      if (!cards.length) continue;
      const shown = cards.slice(0, 3);
      const spacing = 15;
      const x0 = pp.x - ((shown.length - 1) * spacing) / 2 - (cards.length > 3 ? 6 : 0);
      shown.forEach((c, i) => {
        const g = new Graphics();
        const x = x0 + i * spacing;
        const lvl = careCardSize.level(c);
        drawPacket(g, x, pp.y + 20, lvl);
        this.interactive(
          g,
          { kind: 'card', skillId: c.skillId, plantId: p.id },
          new Rectangle(x - 8, pp.y + 0, 16, 21),
        );
        this.layers.near.addChild(g);
      });
      if (cards.length > 3) {
        const more = this.text(`+${cards.length - 3}`, 8, { color: INK.secondary });
        more.position.set(x0 + 3 * spacing - 4, pp.y + 10);
        this.layers.near.addChild(more);
      }
      const names = this.text(truncate(shown.map((c) => c.name).join(' · '), 30), 7.5, {
        italic: true,
        color: INK.secondary,
      });
      names.anchor.set(0.5, 0);
      names.position.set(pp.x, pp.y + 36);
      this.layers.near.addChild(names);
    }
  }

  private buildFar(view: GardenView, layout: GardenLayout): void {
    for (const bp of layout.beds) {
      const bed = view.beds.find((b) => b.id === bp.bedId)!;
      const agg = bedAggregate(view, bed);
      const c = new Container();
      const veil = new Graphics();
      veil
        .roundRect(bp.x + 6, bp.y + 6, bp.w - 12, bp.h - BED_FACE - 12, 5)
        .fill({ color: PAPER, alpha: 0.35 });
      c.addChild(veil);
      const label = this.text(bedLabel(bed), 30, { serif: true, weight: '500' });
      label.position.set(bp.x + 22, bp.y + 16);
      c.addChild(label);
      this.counterScaled.push({ obj: label, base: ZOOM_SCALE.far, max: 2 });
      const lvl = plantBloom.level(agg);
      const g = new Graphics();
      const cx = bp.x + bp.w / 2;
      const cy = bp.y + 16 + (bp.h - BED_FACE) / 2;
      if (lvl === 0) drawHollowBud(g, cx, cy, 0, 26);
      else {
        const n = BLOOM_FLOWERS[lvl] ?? 1;
        for (let k = 0; k < n; k++)
          drawFlower(g, cx + (k - (n - 1) / 2) * 62, cy, 0, BLOOM_OPENNESS[lvl] ?? 0, 30);
      }
      c.addChild(g);
      const v = agg.success.value;
      const summary = this.text(
        `${v === null ? 'no labeled runs' : `${pct(v)} success`} · n=${formatInt(agg.success.n)} · ${formatInt(agg.runs)} runs`,
        24,
        { color: INK.secondary },
      );
      summary.anchor.set(0.5, 0);
      summary.position.set(cx, cy + 40);
      c.addChild(summary);
      this.counterScaled.push({ obj: summary, base: ZOOM_SCALE.far, max: 2 });
      this.layers.far.addChild(c);
    }
    if (layout.compost) {
      const n = layout.weeds.filter((w) => w.inCompost).length;
      const t = this.text(`Compost corner\n${n} weeds`, 22, { serif: true, color: INK.secondary });
      t.position.set(layout.compost.x + 10, layout.compost.y + 8);
      this.layers.far.addChild(t);
    }
  }

  // ---- camera ------------------------------------------------------------------------------

  get scale(): number {
    return this.world.scale.x;
  }

  private viewSize(): { w: number; h: number } {
    return { w: this.app.screen.width, h: this.app.screen.height };
  }

  private applyCamera(): void {
    const s = this.scale;
    const z = zoomLevelFor(s);
    for (const { obj, base, max } of this.counterScaled) {
      const k = Math.min(max, Math.max(1, base / s));
      obj.scale.set(k);
    }
    for (const b of this.hl.over.children) b.scale.set(Math.min(3, Math.max(1, 1 / s)));
    if (z !== this.zoom) {
      this.zoom = z;
      this.cb.onZoomLevel(z);
    }
    const L = this.layers;
    const far = z === 'far';
    L.plants.visible = !far;
    L.bees.visible = !far;
    L.weeds.visible = !far;
    L.playbook.visible = !far;
    L.focus.visible = !far;
    L.plaques.visible = !far;
    L.near.visible = z === 'near';
    L.far.visible = far;
    for (const o of this.overlays) o.camera(s, z);
    this.cb.onCamera();
  }

  get zoomLevel(): ZoomLevel {
    return this.zoom;
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    const s0 = this.scale;
    const s1 = Math.min(4, Math.max(0.12, s0 * factor));
    const wx = (sx - this.world.x) / s0;
    const wy = (sy - this.world.y) / s0;
    this.world.scale.set(s1);
    this.world.position.set(sx - wx * s1, sy - wy * s1);
    this.applyCamera();
  }

  zoomBy(factor: number): void {
    const { w, h } = this.viewSize();
    this.zoomAt(factor, w / 2, h / 2);
  }

  setScale(scale: number): void {
    this.zoomBy(scale / this.scale);
  }

  setZoom(level: ZoomLevel): void {
    if (level === 'far') {
      this.fit();
      if (this.scale >= FAR_BELOW) this.setScale(ZOOM_SCALE.far);
      return;
    }
    if (this.zoom === 'far' && this.layout) {
      const { w, h } = this.viewSize();
      const cx = (w / 2 - this.world.x) / this.scale;
      const cy = (h / 2 - this.world.y) / this.scale;
      this.centerOn(cx, cy, ZOOM_SCALE[level]);
      return;
    }
    this.setScale(ZOOM_SCALE[level]);
  }

  fit(): void {
    if (!this.layout) return;
    const { w, h } = this.viewSize();
    const s = Math.min(w / this.layout.width, h / this.layout.height) * 0.98;
    this.world.scale.set(s);
    this.world.position.set(
      (w - this.layout.width * s) / 2,
      Math.max(0, (h - this.layout.height * s) / 2),
    );
    this.applyCamera();
  }

  centerOn(x: number, y: number, scale = this.scale): void {
    const { w, h } = this.viewSize();
    this.world.scale.set(scale);
    this.world.position.set(w / 2 - x * scale, h / 2 - y * scale);
    this.applyCamera();
  }

  /** Bring a plant into view (zooming to mid if at far), e.g. on keyboard focus. */
  ensureVisible(id: ID): void {
    const pp = this.layout?.plants.get(id);
    if (!pp) return;
    const r = this.plantScreenRect(id);
    const { w, h } = this.viewSize();
    const far = this.zoom === 'far';
    if (far || !r || r.x < 20 || r.y < 20 || r.x + r.w > w - 20 || r.y + r.h > h - 20) {
      this.centerOn(pp.x, pp.y - 40, far ? ZOOM_SCALE.mid : this.scale);
    }
  }

  /** Center of a bed's label plaque in canvas (CSS px) coordinates, if visible. */
  bedLabelScreenPoint(id: ID): { x: number; y: number } | null {
    const plaque = this.plaqueByBed.get(id);
    if (!plaque || !plaque.visible || !this.layers.plaques.visible) return null;
    const b = plaque.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  /** Plant bounds in canvas (CSS px) coordinates. */
  plantScreenRect(id: ID): { x: number; y: number; w: number; h: number } | null {
    const pp = this.layout?.plants.get(id);
    if (!pp) return null;
    const s = this.scale;
    const x0 = (pp.x - 26) * s + this.world.x;
    const y0 = (pp.topY - 16) * s + this.world.y;
    return { x: x0, y: y0, w: 52 * s, h: (pp.y - pp.topY + 24) * s };
  }

  /** Selection marker under a plant (ink ring on the soil). */
  setSelected(id: ID | null): void {
    const g = this.layers.focus;
    g.clear();
    const pp = id ? this.layout?.plants.get(id) : undefined;
    if (!pp) return;
    g.ellipse(pp.x, pp.y + 1, 26, 7).stroke({ color: INK.primary, width: 1.4, alpha: 0.75 });
  }

  /**
   * Router highlight: `plantIds` glow, each with its badge text (e.g. "72%"); everything else
   * dims to 1 − HIGHLIGHT.veilAlpha. An empty list clears it. Survives `setData`.
   */
  highlight(plantIds: readonly ID[], badges: Readonly<Record<ID, string>> = {}): void {
    this.hl.ids = [...plantIds];
    this.hl.badges = badges;
    for (const layer of [this.hl.under, this.hl.over])
      for (const c of layer.removeChildren()) c.destroy({ children: true });
    const on = new Set(plantIds.filter((id) => this.layout?.plants.has(id)));
    const dim = on.size ? 1 - HIGHLIGHT.veilAlpha : 1;
    for (const [name, layer] of Object.entries(this.layers))
      if (name !== 'plants' && name !== 'focus') layer.alpha = dim;
    for (const n of this.plantNodes) n.sprite.alpha = on.has(n.id) || !on.size ? 1 : dim;
    for (const id of on) {
      const pp = this.layout!.plants.get(id)!;
      const g = new Graphics();
      drawGlow(g, pp.x, pp.y, pp.y - pp.topY);
      this.hl.under.addChild(g);
      const label = badges[id];
      if (!label) continue;
      const badge = new Container();
      const t = this.text(label, 10, { weight: '700', color: PAPER });
      t.anchor.set(0.5);
      const bg = new Graphics();
      drawBadge(bg, 0, 0, Math.max(30, t.width + 12));
      badge.addChild(bg, t);
      badge.position.set(pp.x, pp.topY - 18);
      badge.label = `router-badge:${id}`;
      this.hl.over.addChild(badge);
    }
    if (this.view) this.applyCamera();
  }

  get highlighted(): readonly ID[] {
    return this.hl.ids;
  }

  // ---- interaction -------------------------------------------------------------------------

  private bindPointer(canvas: HTMLCanvasElement): void {
    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let last = { x: 0, y: 0 };
    let downAt = { x: 0, y: 0 };
    const down = (e: PointerEvent) => {
      this.pointers.set(e.pointerId, local(e));
      if (this.pointers.size === 1) {
        this.dragging = true;
        this.dragMoved = false;
        last = local(e);
        downAt = last;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    };
    const move = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, local(e));
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (this.pinchDist > 0)
          this.zoomAt(d / this.pinchDist, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        this.pinchDist = d;
        this.dragMoved = true;
        return;
      }
      if (!this.dragging) return;
      const p = local(e);
      if (!this.dragMoved && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) {
        this.dragMoved = true;
        canvas.style.cursor = 'grabbing';
        if (this.hovered) {
          this.hovered = null;
          this.cb.onHover(null, e.clientX, e.clientY);
        }
      }
      if (this.dragMoved) {
        this.world.position.set(this.world.x + p.x - last.x, this.world.y + p.y - last.y);
        this.applyCamera();
      }
      last = p;
    };
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.pointers.size === 0) {
        this.dragging = false;
        canvas.style.cursor = '';
        // dragMoved is read by pointertap (fired after pointerup); reset on next down.
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const k = e.ctrlKey ? 0.01 : 0.0018;
      this.zoomAt(Math.exp(-e.deltaY * k), p.x, p.y);
    };
    const leave = (e: PointerEvent) => {
      if (this.hovered) {
        this.hovered = null;
        this.cb.onHover(null, e.clientX, e.clientY);
      }
    };
    canvas.addEventListener('pointerleave', leave);
    this.cleanup.push(() => canvas.removeEventListener('pointerleave', leave));
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(() => this.cb.onCamera());
    ro.observe(this.host);
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      ro.disconnect();
    });
  }

  // ---- animation ---------------------------------------------------------------------------

  private resetMotion(): void {
    for (const n of this.plantNodes) n.sprite.rotation = 0;
    for (const b of this.beeNodes) this.placeBee(b, b.offset);
    this.drawFlowFrame(0);
  }

  private drawFlowFrame(time: number): void {
    const g = this.layers.flow;
    g.clear();
    for (const f of this.flowNodes) {
      const phase = time * (FLOW_SPEED[f.level] ?? 10);
      for (const path of f.paths) drawFlow(g, path, f.level, phase);
    }
  }

  private tick(deltaMS: number): void {
    if (!this.view) return;
    for (const o of this.overlays) o.tick(deltaMS, this.reducedMotion);
    if (this.reducedMotion) {
      if (this.time === 0) {
        this.drawFlowFrame(0);
        this.time = 1;
      }
      return;
    }
    this.time += deltaMS / 1000;
    const t = this.time;
    this.drawFlowFrame(t);
    if (this.zoom === 'far') return;
    // Ambient sway: no meaning (listed in the legend as "ambient, no meaning").
    for (const n of this.plantNodes) n.sprite.rotation = Math.sin(t * 0.8 + n.phase) * 0.022;
    for (const b of this.beeNodes) this.placeBee(b, (b.offset + t * b.speed) % 1);
  }

  destroy(): void {
    this.destroyed = true;
    for (const f of this.cleanup) f();
    for (const o of this.overlays) o.destroy?.();
    try {
      this.app.destroy({ removeView: true }, { children: true, texture: true });
    } catch {
      // init may not have completed
    }
  }
}
