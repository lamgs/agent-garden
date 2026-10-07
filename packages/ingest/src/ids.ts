import { createHash } from 'node:crypto';

/** Stable id from parts: `<prefix>_<16 hex chars of sha256>`. */
export function stableId(prefix: string, ...parts: (string | number | undefined)[]): string {
  const h = createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('\u0000'))
    .digest('hex');
  return `${prefix}_${h.slice(0, 16)}`;
}

export function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
