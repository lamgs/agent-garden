/** Seeded PRNG (mulberry32) plus helpers. Every random choice in the generator goes through this. */

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

const HEX = '0123456789abcdef';
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Independent stream derived from a label, so one part of the story can't shift another. */
  static derive(seed: number, label: string): Rng {
    return new Rng(hashString(`${seed}:${label}`));
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Weighted choice over [value, weight] pairs. */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r < 0) return v;
    }
    return (pairs[pairs.length - 1] as readonly [T, number])[0];
  }

  chars(n: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(this.next() * alphabet.length)];
    return out;
  }

  hex(n: number): string {
    return this.chars(n, HEX);
  }

  uuid(): string {
    const h = this.hex(32);
    const variant = HEX[8 + Math.floor(this.next() * 4)];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  toolUseId(): string {
    return `toolu_01${this.chars(22, B62)}`;
  }

  messageId(): string {
    return `msg_01${this.chars(22, B62)}`;
  }

  requestId(): string {
    return `req_011C${this.chars(20, B62)}`;
  }

  agentId(): string {
    return `a${this.hex(16)}`;
  }

  /** Roughly normal (sum of uniforms), clamped to [min, max]. */
  around(mean: number, spread: number, min = 0, max = Number.POSITIVE_INFINITY): number {
    const u = (this.next() + this.next() + this.next()) / 3 - 0.5;
    return Math.min(max, Math.max(min, Math.round(mean + u * 2 * spread)));
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const iso = (ms: number): string => new Date(ms).toISOString();
export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY) * DAY;
