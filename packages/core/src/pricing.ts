import type { TokenUsage } from './schema';

/**
 * Versioned USD pricing per million tokens. Source and date: docs/sources.md ("Pricing").
 * Cache writes: 1.25x input (5-minute TTL) and 2x input (1-hour TTL). Cache-read rates differ by model.
 * Users can override entries via garden.yaml (`pricing:`) without editing code.
 */
export const PRICING_VERSION = '2026-10-06';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  contextWindow: number;
}

const M = 1_000_000;
const p = (input: number, output: number, cacheRead: number, contextWindow = M): ModelPrice => ({
  input,
  output,
  cacheRead,
  contextWindow,
});

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50, 1),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25, 0.5),
  'claude-opus-4-8': p(5, 25, 0.5),
  'claude-opus-4-7': p(5, 25, 0.5),
  'claude-opus-4-6': p(5, 25, 0.5),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10, 0.2),
  'claude-sonnet-4-6': p(3, 15, 0.3),
  // Haiku 5.5: rates for prompts up to 100K tokens ($0.50 / $2.50 beyond; not yet modeled).
  'claude-haiku-5-5': p(0.1, 0.5, 0.01),
  'claude-haiku-4-5': p(1, 5, 0.1, 200_000),
};

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Resolve a model id as it appears in transcripts (may carry a date or `[1m]` suffix). */
export function resolveModelPrice(
  model: string,
  overrides: Record<string, ModelPrice> = {},
): ModelPrice | undefined {
  const table = { ...MODEL_PRICES, ...overrides };
  const base = model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  return table[model] ?? table[base];
}

/** Cost in USD, or null when the model is unknown (never silently priced as zero). */
export function costUsd(
  usage: TokenUsage,
  model: string,
  overrides?: Record<string, ModelPrice>,
): number | null {
  const price = resolveModelPrice(model, overrides);
  if (!price) return null;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite5m * price.input * CACHE_WRITE_5M_MULTIPLIER +
      usage.cacheWrite1h * price.input * CACHE_WRITE_1H_MULTIPLIER) /
    M
  );
}

export function modelFamily(
  model: string | undefined,
): 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other' {
  if (!model) return 'other';
  for (const f of ['fable', 'opus', 'sonnet', 'haiku'] as const) if (model.includes(f)) return f;
  return 'other';
}
