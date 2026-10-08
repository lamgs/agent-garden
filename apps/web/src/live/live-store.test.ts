import { describe, expect, it } from 'vitest';
import { LiveStore } from './live-store';

describe('LiveStore and an as-of garden', () => {
  it('stays off while the garden shows a past date, and resumes on "back to now"', () => {
    const s = new LiveStore('?fixture=demo');
    s.setHistorical('2026-08-10T00:00:00Z');
    s.configure('fixture');
    expect(s.get().pill).toBe('off');
    expect(s.get().detail).toMatch(/as of 2026-08-10/);
    s.toggle(); // the pill can't switch it on over a past garden
    expect(s.get().pill).toBe('off');
    s.setHistorical(undefined);
    expect(s.get().pill).not.toBe('off');
    s.stop();
  });

  it('turns a running stream off when the garden is scrubbed back', () => {
    const s = new LiveStore('?fixture=demo');
    s.configure('fixture');
    expect(s.get().pill).not.toBe('off');
    s.setHistorical('2026-08-10T00:00:00Z');
    expect(s.get().pill).toBe('off');
    expect(s.get().snapshot).toBeNull();
    s.stop();
  });

  it('does not resume on "back to now" if the user had switched live off', () => {
    const s = new LiveStore('?fixture=demo&live=off');
    s.configure('fixture');
    s.setHistorical('2026-08-10T00:00:00Z');
    s.setHistorical(undefined);
    expect(s.get().pill).toBe('off');
  });
});
