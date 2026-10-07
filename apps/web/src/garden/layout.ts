/**
 * Pure garden layout. Beds are allotment plots in a grid; every agent has ONE global slot index
 * (main first, then alphabetical) and occupies that slot in every bed, so the same agent sits in the
 * same place in each bed. Beds leave empty slots for agents they don't have.
 */
import { plantHeight, type GardenView, type ID, type PlantSummary } from '@garden/core';
import { BED_FACE, STEM_LENGTH } from './draw';

export const SLOT_W = 96;
export const SLOT_H = 208;
/** Plant base offset from the slot top. */
export const SLOT_BASE = 140;
export const BED_PAD_X = 18;
export const BED_PAD_TOP = 14;
export const WEED_STRIP = 28;
export const BED_GAP_X = 64;
export const LANE = 9;
export const GUTTER_BASE = 30;
export const MARGIN_LEFT = 120;
export const MARGIN_TOP = 24;
export const MARGIN_RIGHT = 40;
export const MARGIN_BOTTOM = 40;
export const COMPOST_W = 170;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}

export interface AgentSlot {
  agentId: ID;
  name: string;
  slot: number;
}

export interface BedPlacement extends Rect {
  bedId: ID;
  rows: number;
  gridRow: number;
  gridCol: number;
  /** The soil surface (excludes the front face). */
  soil: Rect;
}

export interface PlantPlacement {
  plantId: ID;
  bedId: ID;
  agentId: ID;
  slot: number;
  col: number;
  row: number;
  /** Plant base (world coords). */
  x: number;
  y: number;
  /** Top of the stem (approximate), for bee flight paths. */
  topY: number;
}

export interface LoopRoute {
  loopId: ID;
  /** Polylines, each drawn as one channel: row trunks and drops to each target plant. */
  paths: Pt[][];
  /** Where each trunk leaves the garden edge. */
  sources: Pt[];
  /** One end point per (deduplicated) target plant, at the plant base. */
  ends: { plantId: ID; x: number; y: number; dropTop: Pt }[];
}

export interface BeeRoute {
  fromPlantId: ID;
  toPlantId: ID;
  p0: Pt;
  c: Pt;
  p1: Pt;
}

export interface WeedPlacement {
  weedId: ID;
  x: number;
  y: number;
  inCompost: boolean;
}

export interface GatePlacement {
  stepIndex: number;
  x: number;
  y: number;
}

export interface PlaybookRoute {
  playbookId: ID;
  path: Pt[];
  gates: GatePlacement[];
  start: Pt;
}

export interface GardenLayout {
  agents: AgentSlot[];
  cols: number;
  beds: BedPlacement[];
  plants: Map<ID, PlantPlacement>;
  /** Plant ids in focus (Tab) order: bed order, then slot order. */
  focusOrder: ID[];
  loops: LoopRoute[];
  bees: BeeRoute[];
  weeds: WeedPlacement[];
  playbooks: PlaybookRoute[];
  compost: Rect | null;
  width: number;
  height: number;
}

/** Global agent order: main first, then alphabetical (case-insensitive), ties by id. */
export function agentOrder(plants: readonly PlantSummary[]): AgentSlot[] {
  const byAgent = new Map<ID, PlantSummary>();
  for (const p of plants) if (!byAgent.has(p.agentId)) byAgent.set(p.agentId, p);
  const list = [...byAgent.values()].sort((a, b) => {
    const am = a.agentKind === 'main' ? 0 : 1;
    const bm = b.agentKind === 'main' ? 0 : 1;
    if (am !== bm) return am - bm;
    const c = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return c !== 0 ? c : a.agentId.localeCompare(b.agentId);
  });
  return list.map((p, slot) => ({ agentId: p.agentId, name: p.name, slot }));
}

export function columnsFor(nAgents: number): number {
  return Math.max(
    1,
    Math.min(nAgents, Math.max(4, Math.min(8, Math.ceil(Math.sqrt(nAgents * 3))))),
  );
}

export function bedColumnsFor(nBeds: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(nBeds * 1.5)));
}

export function stemTop(p: PlantSummary): number {
  return STEM_LENGTH[plantHeight.level(p)] ?? STEM_LENGTH[0];
}

export function computeLayout(view: GardenView): GardenLayout {
  const agents = agentOrder(view.plants);
  const slotOf = new Map(agents.map((a) => [a.agentId, a.slot]));
  const cols = columnsFor(agents.length);
  const plantById = new Map(view.plants.map((p) => [p.id, p]));
  const plantsByBed = new Map<ID, PlantSummary[]>();
  for (const p of view.plants) {
    const list = plantsByBed.get(p.bedId) ?? [];
    list.push(p);
    plantsByBed.set(p.bedId, list);
  }
  const weedsByBed = new Map<ID, number>();
  for (const w of view.weeds)
    if (w.bedId) weedsByBed.set(w.bedId, (weedsByBed.get(w.bedId) ?? 0) + 1);

  // Bed sizes.
  const bedW = BED_PAD_X * 2 + cols * SLOT_W;
  const sizes = view.beds.map((b) => {
    const ps = plantsByBed.get(b.id) ?? [];
    const maxSlot = ps.reduce((m, p) => Math.max(m, slotOf.get(p.agentId) ?? 0), 0);
    const rows = Math.max(1, Math.ceil((maxSlot + 1) / cols));
    const weeds = weedsByBed.get(b.id) ?? 0;
    const weedRows = weeds === 0 ? 0 : Math.ceil(weeds / Math.max(1, Math.floor((bedW - 40) / 20)));
    const soilH = BED_PAD_TOP + rows * SLOT_H + weedRows * WEED_STRIP;
    return { rows, soilH, h: soilH + BED_FACE };
  });

  // Which loops reach which grid row (for gutter lanes).
  const bedCols = bedColumnsFor(view.beds.length);
  const gridRowOfBed = new Map(view.beds.map((b, i) => [b.id, Math.floor(i / bedCols)]));
  const nGridRows = Math.ceil(view.beds.length / bedCols);
  const lanesByRow: ID[][] = Array.from({ length: nGridRows }, () => []);
  const loopTargets = view.loops.map((l) => ({
    loop: l,
    targets: [...new Set(l.targetPlantIds)].filter((id) => plantById.has(id)),
  }));
  for (const { loop, targets } of loopTargets) {
    const rows = new Set(targets.map((id) => gridRowOfBed.get(plantById.get(id)!.bedId) ?? 0));
    for (const r of [...rows].sort((a, b) => a - b)) lanesByRow[r]!.push(loop.loopId);
  }

  // Place beds row by row.
  const beds: BedPlacement[] = [];
  const rowTop: number[] = [];
  let y = MARGIN_TOP;
  for (let r = 0; r < nGridRows; r++) {
    const gutter = GUTTER_BASE + lanesByRow[r]!.length * LANE;
    y += gutter;
    rowTop.push(y);
    let rowH = 0;
    for (let c = 0; c < bedCols; c++) {
      const i = r * bedCols + c;
      const b = view.beds[i];
      if (!b) break;
      const s = sizes[i]!;
      const x = MARGIN_LEFT + c * (bedW + BED_GAP_X);
      beds.push({
        bedId: b.id,
        x,
        y,
        w: bedW,
        h: s.h,
        rows: s.rows,
        gridRow: r,
        gridCol: c,
        soil: { x, y, w: bedW, h: s.soilH },
      });
      rowH = Math.max(rowH, s.h);
    }
    y += rowH;
  }
  const gridRight = MARGIN_LEFT + bedCols * bedW + (bedCols - 1) * BED_GAP_X;
  const bedById = new Map(beds.map((b) => [b.bedId, b]));

  // Plants.
  const plants = new Map<ID, PlantPlacement>();
  const focusOrder: ID[] = [];
  for (const bed of beds) {
    const ps = [...(plantsByBed.get(bed.bedId) ?? [])].sort(
      (a, b) => (slotOf.get(a.agentId) ?? 0) - (slotOf.get(b.agentId) ?? 0),
    );
    for (const p of ps) {
      const slot = slotOf.get(p.agentId) ?? 0;
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const x = bed.x + BED_PAD_X + col * SLOT_W + SLOT_W / 2;
      const py = bed.y + BED_PAD_TOP + row * SLOT_H + SLOT_BASE;
      plants.set(p.id, {
        plantId: p.id,
        bedId: bed.bedId,
        agentId: p.agentId,
        slot,
        col,
        row,
        x,
        y: py,
        topY: py - stemTop(p),
      });
      focusOrder.push(p.id);
    }
  }

  // Irrigation: from the garden's left edge along the gutter above each bed row, then down the
  // gap left of each target plant's slot to its base.
  const edgeX = MARGIN_LEFT - 70;
  const perPlantLoopCount = new Map<ID, number>();
  const loops: LoopRoute[] = loopTargets.map(({ loop, targets }) => {
    const paths: Pt[][] = [];
    const sources: Pt[] = [];
    const ends: LoopRoute['ends'] = [];
    const byRow = new Map<number, ID[]>();
    for (const id of targets) {
      const r = gridRowOfBed.get(plants.get(id)?.bedId ?? '') ?? 0;
      byRow.set(r, [...(byRow.get(r) ?? []), id]);
    }
    for (const [r, ids] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const lane = lanesByRow[r]!.indexOf(loop.loopId);
      const laneY = rowTop[r]! - GUTTER_BASE + 10 - (lanesByRow[r]!.length - 1 - lane) * LANE;
      let maxX = edgeX;
      for (const id of ids) {
        const pp = plants.get(id);
        if (!pp) continue;
        const k = perPlantLoopCount.get(id) ?? 0;
        perPlantLoopCount.set(id, k + 1);
        const dropX = pp.x - SLOT_W / 2 + 7 + k * 5;
        const baseY = pp.y - 3 - k * 4;
        const dropTop = { x: dropX, y: laneY };
        paths.push([dropTop, { x: dropX, y: baseY }, { x: pp.x - 7, y: baseY }]);
        ends.push({ plantId: id, x: pp.x - 7, y: baseY, dropTop });
        maxX = Math.max(maxX, dropX);
      }
      paths.unshift([
        { x: edgeX, y: laneY },
        { x: maxX, y: laneY },
      ]);
      sources.push({ x: edgeX, y: laneY });
    }
    return { loopId: loop.loopId, paths, sources, ends };
  });

  // Bees: arcs from the parent's stem top to the child's.
  const bees: BeeRoute[] = [];
  for (const b of view.bees) {
    const a = plants.get(b.fromPlantId);
    const c = plants.get(b.toPlantId);
    if (!a || !c || a === c) continue;
    const p0 = { x: a.x, y: a.topY - 6 };
    const p1 = { x: c.x, y: c.topY - 6 };
    const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    bees.push({
      fromPlantId: b.fromPlantId,
      toPlantId: b.toPlantId,
      p0,
      p1,
      c: { x: (p0.x + p1.x) / 2, y: Math.min(p0.y, p1.y) - 22 - d * 0.18 },
    });
  }

  // Weeds: bottom-right corner of their bed, or the compost corner.
  const weeds: WeedPlacement[] = [];
  const perBedWeed = new Map<ID, number>();
  const unassigned = view.weeds.filter((w) => !w.bedId || !bedById.has(w.bedId));
  const compostCols = 6;
  const compost: Rect | null =
    unassigned.length === 0
      ? null
      : {
          x: gridRight + BED_GAP_X,
          y: rowTop[0] ?? MARGIN_TOP,
          w: COMPOST_W,
          h: 62 + Math.ceil(unassigned.length / compostCols) * 30,
        };
  let ci = 0;
  for (const w of view.weeds) {
    const bed = w.bedId ? bedById.get(w.bedId) : undefined;
    if (bed) {
      const i = perBedWeed.get(bed.bedId) ?? 0;
      perBedWeed.set(bed.bedId, i + 1);
      const perRow = Math.max(1, Math.floor((bed.w - 40) / 20));
      weeds.push({
        weedId: w.id,
        x: bed.x + bed.w - 18 - (i % perRow) * 20,
        y: bed.soil.y + bed.soil.h - 6 - Math.floor(i / perRow) * WEED_STRIP,
        inCompost: false,
      });
    } else if (compost) {
      weeds.push({
        weedId: w.id,
        x: compost.x + 22 + (ci % compostCols) * 25,
        y: compost.y + 74 + Math.floor(ci / compostCols) * 30,
        inCompost: true,
      });
      ci++;
    }
  }

  // Playbooks: stepping stones through the steps' plants, one gate per step.
  const playbooks: PlaybookRoute[] = view.playbooks.map((pb) => {
    const gates: GatePlacement[] = [];
    const groups: { key: string; at: Pt; idx: number[] }[] = [];
    pb.steps.forEach((s, i) => {
      const pp = s.plantId ? plants.get(s.plantId) : undefined;
      const bed = s.bedId ? bedById.get(s.bedId) : pp ? bedById.get(pp.bedId) : undefined;
      const at: Pt = pp
        ? { x: pp.x, y: pp.y + 62 }
        : bed
          ? { x: bed.x + bed.w / 2, y: bed.soil.y + bed.soil.h - 10 }
          : { x: edgeX, y: y + 20 };
      const key = `${Math.round(at.x)}:${Math.round(at.y)}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.idx.push(i);
      else groups.push({ key, at, idx: [i] });
    });
    const path: Pt[] = [];
    for (const g of groups) {
      const m = g.idx.length;
      g.idx.forEach((stepIndex, k) => {
        const gx = g.at.x + (k - (m - 1) / 2) * 40;
        gates.push({ stepIndex, x: gx, y: g.at.y });
        path.push({ x: gx, y: g.at.y });
      });
    }
    const first = path[0] ?? { x: edgeX, y };
    const start = { x: first.x - 20, y: first.y };
    return { playbookId: pb.id, path: [start, ...path], gates, start };
  });

  const width = (compost ? compost.x + compost.w : gridRight) + MARGIN_RIGHT;
  const height = Math.max(y, compost ? compost.y + compost.h : 0) + MARGIN_BOTTOM;
  return {
    agents,
    cols,
    beds,
    plants,
    focusOrder,
    loops,
    bees,
    weeds,
    playbooks,
    compost,
    width,
    height,
  };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A point on a quadratic bee arc, t in [0, 1]. */
export function beePoint(r: Pick<BeeRoute, 'p0' | 'c' | 'p1'>, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * r.p0.x + 2 * u * t * r.c.x + t * t * r.p1.x,
    y: u * u * r.p0.y + 2 * u * t * r.c.y + t * t * r.p1.y,
  };
}

/** Sampled bee arc as a polyline. */
export function beeArc(r: BeeRoute, n = 24): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => beePoint(r, i / n));
}
