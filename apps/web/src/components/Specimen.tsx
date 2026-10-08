/**
 * Plants and soil plots for the plant / compare / replant pages, drawn by the garden's own code
 * (`drawPlant`, `drawBed`) through a CanvasPen. Same genotype → the same drawing as in the garden,
 * just at a larger scale; the bed look comes from the same registry levels the renderer uses.
 */
import { useEffect, useRef } from 'react';
import { bedStrata, bedTexture, bedTone, type BedSummary, type PlantSummary } from '@garden/core';
import { BED_FACE, drawBed, drawPlant, hashString, PLANT_FRAME } from '../garden/draw';
import { genotypeKey, genotypeOf } from '../garden/genotype';
import { CanvasPen, type Pen } from '../garden/pen';
import { familyTone } from '../garden/swatches';

export function bedLook(bed: BedSummary) {
  return {
    tone: familyTone(bedTone.level(bed)),
    texture: bedTexture.level(bed),
    strata: bedStrata.level(bed),
  };
}

export function bedToneOf(bed: BedSummary): string {
  return familyTone(bedTone.level(bed));
}

/** A canvas that runs a Pen drawing at device resolution. `drawKey` must change when the drawing does. */
export function PenCanvas({
  width,
  height,
  drawKey,
  draw,
  label,
  className,
}: {
  width: number;
  height: number;
  drawKey: string;
  draw: (pen: Pen, ctx: CanvasRenderingContext2D) => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawRef.current(new CanvasPen(ctx), ctx);
  }, [width, height, drawKey]);
  return (
    <canvas
      ref={ref}
      className={className}
      style={{ width, height }}
      width={width}
      height={height}
      role="img"
      aria-label={label}
    />
  );
}

/** Draw one plant with its base at (x, y), scaled by k. */
export function drawPlantAt(
  ctx: CanvasRenderingContext2D,
  pen: Pen,
  p: PlantSummary,
  x: number,
  y: number,
  k: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  drawPlant(pen, genotypeOf(p));
  ctx.restore();
}

/** A single plant, no soil (used inline, e.g. in tables). */
export function PlantSprite({ plant, height }: { plant: PlantSummary; height: number }) {
  const k = height / PLANT_FRAME.h;
  const width = Math.round(PLANT_FRAME.w * k);
  return (
    <PenCanvas
      width={width}
      height={height}
      drawKey={`${genotypeKey(genotypeOf(plant))}:${height}`}
      label={`${plant.name}, drawn as in the garden`}
      className="plant-sprite"
      draw={(pen, ctx) => drawPlantAt(ctx, pen, plant, -PLANT_FRAME.x * k, -PLANT_FRAME.y * k, k)}
    />
  );
}

export interface PlotPlant {
  plant: PlantSummary;
  /** Horizontal position as a share of the plot width (0..1). */
  at: number;
}

/**
 * A soil plot: the bed drawn with its real look (edging = model family, texture = tools + MCP,
 * strata = instruction size) and plants standing in it at scale `k`.
 */
export function SoilPlot({
  bed,
  plants,
  width,
  height,
  k,
  label,
}: {
  bed: BedSummary;
  plants: PlotPlant[];
  width: number;
  height: number;
  k: number;
  label: string;
}) {
  const look = bedLook(bed);
  const key = [
    bed.id,
    look.tone,
    look.texture,
    look.strata,
    k,
    ...plants.map((p) => `${p.at}:${genotypeKey(genotypeOf(p.plant))}`),
  ].join('|');
  return (
    <PenCanvas
      width={width}
      height={height}
      drawKey={key}
      label={label}
      className="soil-plot"
      draw={(pen, ctx) => {
        drawBed(pen, 6, 6, width - 12, height - 12, look, hashString(bed.id));
        const base = height - 6 - BED_FACE - 10;
        for (const p of plants) drawPlantAt(ctx, pen, p.plant, 6 + p.at * (width - 12), base, k);
      }}
    />
  );
}
