import type { TokenUsage } from '@garden/core';
import { PRE_REDACTION_CAP } from '../contracts';
import type { Usage } from './schema';

export const WITHHELD_PREVIEW = '[content withheld: sensitive path]';

export function cap(text: string): string {
  return text.length > PRE_REDACTION_CAP ? text.slice(0, PRE_REDACTION_CAP) : text;
}

/** User text that the harness injected (not typed by a person). Slash commands are NOT injected. */
const INJECTED_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<agent-message',
  'Caveat:',
];

export function isInjectedText(text: string): boolean {
  const t = text.trimStart();
  if (t.includes('<command-name>')) return false;
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

export function isInterruptText(text: string): boolean {
  return text.trimStart().startsWith('[Request interrupted by user');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text of a tool_result `content` (string, or list of blocks). */
export function blockContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (isRecord(b)) {
      if (typeof b.text === 'string') parts.push(b.text);
      else if (typeof b.type === 'string') parts.push(`[${b.type}]`);
    }
  }
  return parts.join('\n');
}

/** Compact JSON for previews; never throws. */
export function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '[unserializable input]';
  }
}

/** Input fields that carry file content; removed from call previews when the path is sensitive. */
const CONTENT_FIELDS = ['content', 'new_string', 'old_string', 'edits', 'new_source'];

export function scrubSensitiveInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!CONTENT_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

export function inputString(input: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** API usage → TokenUsage. Missing cache_creation breakdown counts everything as 5m writes. */
export function toTokenUsage(u: Usage): TokenUsage {
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  const b5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const b1 = u.cache_creation?.ephemeral_1h_input_tokens;
  const hasBreakdown = b5 !== undefined || b1 !== undefined;
  const tokens: TokenUsage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: hasBreakdown ? (b5 ?? 0) : cacheCreation,
    cacheWrite1h: hasBreakdown ? (b1 ?? 0) : 0,
  };
  const thinking = u.output_tokens_details?.thinking_tokens;
  if (thinking !== undefined) tokens.thinking = thinking;
  return tokens;
}

export function contextTokensOf(u: Usage): number {
  return (
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  );
}

export function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
}

export function addUsage(into: TokenUsage, u: TokenUsage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
  into.thinking = (into.thinking ?? 0) + (u.thinking ?? 0);
}
