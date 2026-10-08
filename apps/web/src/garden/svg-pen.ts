/**
 * A Pen that records SVG path elements, with the same semantics as CanvasPen / Pixi Graphics
 * (fill and stroke consume the current path; a stroke right after a fill reuses that path).
 * Lets DOM pages (the knowledge map) draw with the exact functions the legend swatches use.
 */
import type { FillStyle, Pen, StrokeStyle } from './pen';

export interface SvgShape {
  d: string;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

export class SvgPen implements Pen {
  readonly shapes: SvgShape[] = [];
  private d: string[] = [];
  private last: { d: string; op: 'fill' | 'stroke' } | null = null;

  moveTo(x: number, y: number): this {
    this.d.push(`M${n(x)} ${n(y)}`);
    return this;
  }
  lineTo(x: number, y: number): this {
    this.d.push(`L${n(x)} ${n(y)}`);
    return this;
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): this {
    this.d.push(`Q${n(cpx)} ${n(cpy)} ${n(x)} ${n(y)}`);
    return this;
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.d.push(`C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(x)} ${n(y)}`);
    return this;
  }
  circle(x: number, y: number, r: number): this {
    return this.ellipse(x, y, r, r);
  }
  ellipse(x: number, y: number, rx: number, ry: number): this {
    this.d.push(
      `M${n(x + rx)} ${n(y)}A${n(rx)} ${n(ry)} 0 1 0 ${n(x - rx)} ${n(y)}A${n(rx)} ${n(ry)} 0 1 0 ${n(x + rx)} ${n(y)}Z`,
    );
    return this;
  }
  rect(x: number, y: number, w: number, h: number): this {
    this.d.push(`M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`);
    return this;
  }
  roundRect(x: number, y: number, w: number, h: number, r: number): this {
    const k = Math.max(0, Math.min(r, w / 2, h / 2));
    this.d.push(
      `M${n(x + k)} ${n(y)}H${n(x + w - k)}Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + k)}V${n(y + h - k)}` +
        `Q${n(x + w)} ${n(y + h)} ${n(x + w - k)} ${n(y + h)}H${n(x + k)}Q${n(x)} ${n(y + h)} ${n(x)} ${n(y + h - k)}` +
        `V${n(y + k)}Q${n(x)} ${n(y)} ${n(x + k)} ${n(y)}Z`,
    );
    return this;
  }
  poly(points: number[], close = true): this {
    for (let i = 0; i + 1 < points.length; i += 2)
      this.d.push(`${i === 0 ? 'M' : 'L'}${n(points[i]!)} ${n(points[i + 1]!)}`);
    if (close) this.d.push('Z');
    return this;
  }
  closePath(): this {
    this.d.push('Z');
    return this;
  }
  private take(op: 'fill' | 'stroke'): string {
    const reuse = this.d.length === 0 && this.last && this.last.op !== op;
    const d = reuse ? this.last!.d : this.d.join('');
    this.last = { d, op };
    this.d = [];
    return d;
  }
  fill(style: FillStyle): this {
    const d = this.take('fill');
    if (d) this.shapes.push({ d, fill: style.color, fillOpacity: style.alpha ?? 1 });
    return this;
  }
  stroke(style: StrokeStyle): this {
    const d = this.take('stroke');
    if (d)
      this.shapes.push({
        d,
        stroke: style.color,
        strokeWidth: style.width,
        strokeOpacity: style.alpha ?? 1,
        cap: style.cap ?? 'round',
        join: style.join ?? 'round',
      });
    return this;
  }
}
