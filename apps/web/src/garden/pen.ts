/**
 * The minimal drawing surface shared by the Pixi renderer and the legend swatches.
 * A PixiJS v8 `Graphics` satisfies it structurally; `CanvasPen` implements the same path
 * semantics on a 2D canvas (fill/stroke consume the current path; a stroke right after a fill
 * reuses that fill's path). One drawing code path → the legend shows exactly what the garden draws.
 */
export interface FillStyle {
  color: string;
  alpha?: number;
}

export interface StrokeStyle {
  color: string;
  width: number;
  alpha?: number;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

export interface Pen {
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): unknown;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): unknown;
  circle(x: number, y: number, r: number): unknown;
  ellipse(x: number, y: number, rx: number, ry: number): unknown;
  rect(x: number, y: number, w: number, h: number): unknown;
  roundRect(x: number, y: number, w: number, h: number, r: number): unknown;
  poly(points: number[], close?: boolean): unknown;
  closePath(): unknown;
  fill(style: FillStyle): unknown;
  stroke(style: StrokeStyle): unknown;
}

/** Pen over CanvasRenderingContext2D, matching Pixi v8 Graphics path semantics. */
export class CanvasPen implements Pen {
  private path = new Path2D();
  private last: { path: Path2D; op: 'fill' | 'stroke' } | null = null;
  private tick = 0;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  private touch(): Path2D {
    this.tick++;
    return this.path;
  }
  moveTo(x: number, y: number): this {
    this.touch().moveTo(x, y);
    return this;
  }
  lineTo(x: number, y: number): this {
    this.touch().lineTo(x, y);
    return this;
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): this {
    this.touch().quadraticCurveTo(cpx, cpy, x, y);
    return this;
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.touch().bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    return this;
  }
  circle(x: number, y: number, r: number): this {
    const p = this.touch();
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, Math.PI * 2);
    p.closePath();
    return this;
  }
  ellipse(x: number, y: number, rx: number, ry: number): this {
    const p = this.touch();
    p.moveTo(x + rx, y);
    p.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    p.closePath();
    return this;
  }
  rect(x: number, y: number, w: number, h: number): this {
    this.touch().rect(x, y, w, h);
    return this;
  }
  roundRect(x: number, y: number, w: number, h: number, r: number): this {
    this.touch().roundRect(x, y, w, h, r);
    return this;
  }
  poly(points: number[], close = true): this {
    const p = this.touch();
    for (let i = 0; i + 1 < points.length; i += 2) {
      if (i === 0) p.moveTo(points[0]!, points[1]!);
      else p.lineTo(points[i]!, points[i + 1]!);
    }
    if (close) p.closePath();
    return this;
  }
  closePath(): this {
    this.touch().closePath();
    return this;
  }
  private take(op: 'fill' | 'stroke'): Path2D {
    const reuse = this.tick === 0 && this.last && this.last.op !== op;
    const path = reuse ? this.last!.path : this.path;
    this.last = { path, op };
    this.path = new Path2D();
    this.tick = 0;
    return path;
  }
  fill(style: FillStyle): this {
    const path = this.take('fill');
    this.ctx.globalAlpha = style.alpha ?? 1;
    this.ctx.fillStyle = style.color;
    this.ctx.fill(path);
    this.ctx.globalAlpha = 1;
    return this;
  }
  stroke(style: StrokeStyle): this {
    const path = this.take('stroke');
    this.ctx.globalAlpha = style.alpha ?? 1;
    this.ctx.strokeStyle = style.color;
    this.ctx.lineWidth = style.width;
    this.ctx.lineCap = style.cap ?? 'round';
    this.ctx.lineJoin = style.join ?? 'round';
    this.ctx.stroke(path);
    this.ctx.globalAlpha = 1;
    return this;
  }
}

/** Records calls; used by unit tests to check that drawing code is deterministic and non-empty. */
export class RecordingPen implements Pen {
  readonly ops: string[] = [];
  private rec(name: string, args: unknown[]): this {
    this.ops.push(
      `${name}(${args.map((a) => (typeof a === 'number' ? a.toFixed(2) : JSON.stringify(a))).join(',')})`,
    );
    return this;
  }
  moveTo(...a: number[]): this {
    return this.rec('moveTo', a);
  }
  lineTo(...a: number[]): this {
    return this.rec('lineTo', a);
  }
  quadraticCurveTo(...a: number[]): this {
    return this.rec('quad', a);
  }
  bezierCurveTo(...a: number[]): this {
    return this.rec('bezier', a);
  }
  circle(...a: number[]): this {
    return this.rec('circle', a);
  }
  ellipse(...a: number[]): this {
    return this.rec('ellipse', a);
  }
  rect(...a: number[]): this {
    return this.rec('rect', a);
  }
  roundRect(...a: number[]): this {
    return this.rec('roundRect', a);
  }
  poly(points: number[], close?: boolean): this {
    return this.rec('poly', [points, close ?? true]);
  }
  closePath(): this {
    return this.rec('closePath', []);
  }
  fill(style: FillStyle): this {
    return this.rec('fill', [style]);
  }
  stroke(style: StrokeStyle): this {
    return this.rec('stroke', [style]);
  }
}
