/**
 * Live previews: every string the live layer emits is produced here. Redaction runs on (up to)
 * LIVE_REDACT_WINDOW chars, and only then is the result cut to LIVE_PREVIEW_MAX, so a secret is
 * never cut in half before the detectors see it. The window is far larger than the preview: a
 * detector replaces a secret of n chars with a ~30-char marker, which can shrink text at most ~7x
 * (a private-key block), so the first 120 output chars always come from fully redacted input.
 */
import { isSensitivePath, type Redactor } from '../redact';
import { mcpServerOf } from '../adapters/claude-code/transcript/harness';
import { inputString } from '../adapters/claude-code/transcript/text';
import { LIVE_PREVIEW_MAX } from './types';

export const LIVE_REDACT_WINDOW = 20_000;
export const SENSITIVE_DETAIL = '[sensitive path]';

/** Redact, collapse whitespace, then cut to ≤ max chars without splitting a redaction marker. */
export function livePreview(redactor: Redactor, text: string, max = LIVE_PREVIEW_MAX): string {
  const red: string = redactor.text(text.slice(0, LIVE_REDACT_WINDOW));
  const flat = red.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = markerSafeCut(flat, max - 1); // room for the ellipsis
  return `${flat.slice(0, cut).trimEnd()}…`;
}

const MARKER = '[REDACTED:';

/** The largest cut ≤ `cut` that does not fall inside a (possibly nested) redaction marker. */
function markerSafeCut(text: string, cut: number): number {
  let i = text.indexOf(MARKER);
  while (i !== -1 && i < cut) {
    // Find the end of this outermost marker, allowing nested markers inside it.
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text.startsWith(MARKER, j)) {
        depth++;
        j += MARKER.length - 1;
      } else if (text[j] === ']' && --depth === 0) break;
    }
    if (j >= cut) return i; // the marker straddles the cut: drop it whole
    i = text.indexOf(MARKER, j + 1);
  }
  return cut;
}

/** Raw (pre-redaction) short label for a tool call: the part a person would glance at. */
export function toolLabel(name: string, input: unknown): string {
  const path = inputString(input, 'file_path', 'notebook_path', 'path');
  if (path && isSensitivePath(path)) return SENSITIVE_DETAIL;
  switch (name) {
    case 'Bash':
      // Whole command: livePreview redacts it as one text (multi-line secrets) and then cuts it.
      return inputString(input, 'command') ?? '';
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'LS':
      return path ?? '';
    case 'Grep':
    case 'Glob':
      return [inputString(input, 'pattern'), path].filter(Boolean).join(' in ');
    case 'WebFetch':
      return inputString(input, 'url') ?? '';
    case 'WebSearch':
      return inputString(input, 'query') ?? '';
    case 'Agent':
    case 'Task':
      return [inputString(input, 'subagent_type'), inputString(input, 'description')]
        .filter(Boolean)
        .join(': ');
    case 'Skill':
      return inputString(input, 'skill', 'name', 'command') ?? '';
    default:
      // MCP and other tools: name only (inputs can be arbitrary payloads).
      return mcpServerOf(name) ? name.slice('mcp__'.length).replace('__', ' / ') : name;
  }
}
