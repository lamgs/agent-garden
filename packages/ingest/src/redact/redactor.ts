import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RedactedText } from '@garden/core';
import { ALWAYS_REDACT_MAP_KEYS, DETECTORS } from './patterns';

export interface RedactionStats {
  /** Count of replaced secrets by detector kind. */
  byKind: Record<string, number>;
}

/** Keys whose values are truncated after redaction (previews). */
const PREVIEW_KEYS = new Set([
  'preview',
  'taskPreview',
  'message',
  'description',
  'note',
  'detail',
]);
export const PREVIEW_MAX_CHARS = 2000;

/**
 * Replaces secrets with `[REDACTED:<kind>:<tag>]`. The tag is an HMAC of the secret under a
 * per-install key, so the same secret maps to the same tag (useful for spotting reuse) without
 * being reversible or confirmable by anyone who lacks the local key.
 */
export class Redactor {
  readonly stats: RedactionStats = { byKind: {} };

  constructor(private readonly key: Buffer) {
    if (key.length < 16) throw new Error('Redactor key must be at least 16 bytes');
  }

  /** Load or create the per-install key file (mode 0600). */
  static fromKeyFile(path: string): Redactor {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    return new Redactor(Buffer.from(readFileSync(path, 'utf8').trim(), 'hex'));
  }

  private tag(kind: string, secret: string): string {
    this.stats.byKind[kind] = (this.stats.byKind[kind] ?? 0) + 1;
    const h = createHmac('sha256', this.key).update(secret).digest('hex').slice(0, 8);
    return `[REDACTED:${kind}:${h}]`;
  }

  /** Redact a string. Runs every detector; specific detectors run before generic ones. */
  text(input: string, maxChars?: number): RedactedText {
    let out = input;
    for (const d of DETECTORS) {
      out = out.replace(d.re, (match: string, ...groups: unknown[]) => {
        if (d.group === undefined) return this.tag(d.kind, match);
        const caps = groups.slice(0, -2) as (string | undefined)[];
        const secret = caps[d.group - 1];
        if (!secret || (d.accept && !d.accept(secret))) return match;
        // Replace only the secret; keep key names and separators for readability.
        const at = match.lastIndexOf(secret);
        return match.slice(0, at) + this.tag(d.kind, secret) + match.slice(at + secret.length);
      });
    }
    // Truncate only after redaction so a secret can never be cut in half and slip through.
    if (maxChars !== undefined && out.length > maxChars) {
      let cut = maxChars;
      // Never cut a redaction marker in half.
      const open = out.lastIndexOf('[REDACTED:', cut);
      if (open !== -1 && out.indexOf(']', open) >= cut) cut = out.indexOf(']', open) + 1;
      if (cut < out.length) out = `${out.slice(0, cut)}… [truncated ${out.length - cut} chars]`;
    }
    return out as RedactedText;
  }

  /**
   * Replace every value of a config map such as `env` or `headers`, keeping key names.
   * Use for MCP server configs, settings `env`, and hook environments.
   */
  configMap(map: Record<string, unknown>): Record<string, RedactedText> {
    const out: Record<string, RedactedText> = {};
    for (const [k, v] of Object.entries(map))
      out[k] = this.tag('config_value', String(v)) as RedactedText;
    return out;
  }

  /**
   * Deep-redact an arbitrary record produced by an adapter: every string is redacted,
   * values under ALWAYS_REDACT_MAP_KEYS are replaced wholesale, and preview-like fields
   * are truncated after redaction.
   */
  deep<T>(value: Unredacted<T>): T {
    return this.walk(value, undefined) as T;
  }

  private walk(value: unknown, key: string | undefined): unknown {
    if (typeof value === 'string') {
      return this.text(value, key && PREVIEW_KEYS.has(key) ? PREVIEW_MAX_CHARS : undefined);
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, key));
    if (value && typeof value === 'object') {
      if (key && ALWAYS_REDACT_MAP_KEYS.has(key)) {
        return this.configMap(value as Record<string, unknown>);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, k);
      return out;
    }
    return value;
  }
}

/** The adapter-facing shape of a schema type: RedactedText fields are plain strings. */
export type Unredacted<T> = T extends RedactedText
  ? string
  : T extends readonly (infer U)[]
    ? Unredacted<U>[]
    : T extends object
      ? { [K in keyof T]: Unredacted<T[K]> }
      : T;
