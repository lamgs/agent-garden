import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ENCODINGS, legend } from '@garden/core';
import { RecordingPen } from '../garden/pen';
import { SWATCHES } from '../garden/swatches';
import { Legend } from './Legend';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('legend drawer', () => {
  it('renders every registry entry with one swatch per level', () => {
    const html = renderToStaticMarkup(
      createElement(Legend, { open: true, onClose: () => undefined }),
    );
    for (const e of ENCODINGS) {
      expect(html).toContain(`data-encoding-id="${e.id}"`);
      expect(html).toContain(esc(e.channel));
      expect(html).toContain(esc(e.action));
      for (const level of e.levels) expect(html).toContain(esc(level));
    }
    const canvases = html.match(/<canvas/g)?.length ?? 0;
    expect(canvases).toBe(legend().reduce((n, e) => n + e.levels.length, 0));
    expect(html).toContain('ambient, no meaning');
  });

  it('has a swatch drawn by the garden drawing code for every level of every encoding', () => {
    for (const e of legend()) {
      const sw = SWATCHES[e.id];
      expect(sw, e.id).toBeDefined();
      const drawn = e.levels.map((_, i) => {
        const pen = new RecordingPen();
        sw!.draw(pen, i);
        expect(pen.ops.length, `${e.id} level ${i}`).toBeGreaterThan(0);
        return pen.ops.join('|');
      });
      if (e.levels.length > 1)
        expect(new Set(drawn).size, `${e.id}: levels must look different`).toBe(drawn.length);
    }
  });
});
