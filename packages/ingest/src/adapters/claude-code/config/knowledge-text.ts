/**
 * Text helpers for the knowledge scanner. They read instruction/memory text and return ONLY
 * derived facts (reference targets, positions, passage hashes and sizes). Text never leaves here.
 * Rules mirror Claude Code 2.1.293 (docs/sources.md, "Knowledge sources").
 */
import { createHash } from 'node:crypto';

/** Replace a span with spaces (keeps offsets and line numbers stable). */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * Text with fenced code blocks, inline code spans, and HTML comments blanked out: Claude Code does
 * not treat `@path` inside code or comments as an import. Indented (4-space) code blocks are not
 * detected (known gap; they are rare in instruction files).
 */
export function stripCode(text: string): string {
  let t = text.replace(/<!--[\s\S]*?-->/g, blank);
  // Fenced blocks: ``` or ~~~ (up to 3 spaces indent) until a closing fence of the same char.
  t = t.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, blank);
  // Inline code spans with matching backtick runs.
  t = t.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)|``/g, blank);
  return t;
}

export interface RefHit {
  /** As written, e.g. `docs/api.md` (no leading @, fragment removed, `\ ` unescaped). */
  target: string;
  /** 1-based line number in the file. */
  line: number;
  /** Byte offset of the reference in the file. */
  byteOffset: number;
}

const lineOf = (text: string, idx: number) => text.slice(0, idx).split('\n').length;
const byteOf = (text: string, idx: number) => Buffer.byteLength(text.slice(0, idx), 'utf8');

/**
 * `@path` imports. Claude Code's pattern: `(?:^|\s)@((?:[^\s\\]|\\ )+)`, `#fragment` stripped, `\ `
 * unescaped; a target counts when it starts with `./`, `~/`, `/` (not `/` alone), or an
 * alphanumeric/`._-` character. Matches inside code spans, code blocks, and HTML comments are ignored.
 */
export function extractImports(text: string): RefHit[] {
  const t = stripCode(text);
  const out: RefHit[] = [];
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    let target = m[1] ?? '';
    const hash = target.indexOf('#');
    if (hash !== -1) target = target.slice(0, hash);
    target = target.replaceAll('\\ ', ' ');
    if (!target) continue;
    const ok =
      target.startsWith('./') ||
      target.startsWith('~/') ||
      (target.startsWith('/') && target !== '/') ||
      (!target.startsWith('@') && !/^[#%^&*()]+/.test(target) && /^[a-zA-Z0-9._-]/.test(target));
    if (!ok) continue;
    const idx = m.index + m[0].indexOf('@');
    out.push({ target, line: lineOf(text, idx), byteOffset: byteOf(text, idx) });
  }
  return out;
}

/** An import target that looks like a file (has a path prefix or an extension), not a package or handle. */
export function looksLikeFile(target: string): boolean {
  if (/^(\.{1,2}\/|~\/|\/)/.test(target)) return true;
  const last = target.split('/').pop() ?? '';
  return /\.[A-Za-z0-9]{1,8}$/.test(last);
}

/** Markdown links to local `.md` files, e.g. MEMORY.md's `- [Title](feedback_testing.md) — hook`. */
export function extractLinks(text: string): RefHit[] {
  const t = stripCode(text);
  const out: RefHit[] = [];
  const re = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    let target = m[1] ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, …
    const hash = target.indexOf('#');
    if (hash !== -1) target = target.slice(0, hash);
    try {
      target = decodeURIComponent(target);
    } catch {
      // keep as written
    }
    if (!/\.md$/i.test(target)) continue;
    out.push({ target, line: lineOf(text, m.index), byteOffset: byteOf(text, m.index) });
  }
  return out;
}

/**
 * Plain mentions of `.md` paths (`docs/schema.md`, `memory/feedback_testing.md`, `PLAN.md`), including
 * inside backticks. Globs (`agents/*.md`), URLs, and `@imports` are excluded.
 */
export function extractMentions(text: string): RefHit[] {
  const out: RefHit[] = [];
  const re = /(?<![\w@/.*~-])((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.md)(?![\w*/-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[1] ?? '';
    if (/^\.+md$/i.test(target)) continue;
    out.push({ target, line: lineOf(text, m.index), byteOffset: byteOf(text, m.index) });
  }
  return out;
}

/** Normalize a passage for duplicate detection: case, whitespace, list/heading markers, edge punctuation. */
export function normalizePassage(p: string): string {
  return p
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, ''))
    .join(' ')
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?-]+|[\s.,;:!?-]+$/g, '')
    .trim();
}

/** Passages shorter than this (normalized) are too generic to call duplicates ("## Commands"). */
export const MIN_PASSAGE_CHARS = 40;

/**
 * Split into passages: blank-line-separated blocks; list items are passages of their own
 * (continuation lines included). Frontmatter is skipped. Returns sha256(normalized) and byte size.
 */
export function passages(text: string): { hash: string; bytes: number }[] {
  const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const units: string[] = [];
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const items: string[] = [];
    let cur: string[] = [];
    let isList = false;
    for (const l of lines) {
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)) {
        if (cur.length) items.push(cur.join('\n'));
        cur = [l];
        isList = true;
      } else cur.push(l);
    }
    if (cur.length) items.push(cur.join('\n'));
    units.push(...(isList ? items : [block]));
  }
  const out: { hash: string; bytes: number }[] = [];
  for (const u of units) {
    const n = normalizePassage(u);
    if (n.length < MIN_PASSAGE_CHARS) continue;
    out.push({
      hash: createHash('sha256').update(n).digest('hex'),
      bytes: Buffer.byteLength(u.trim(), 'utf8'),
    });
  }
  return out;
}

/**
 * The part of MEMORY.md Claude Code loads: trimmed, first 200 lines, then cut at the last newline
 * before 25,000 bytes. Returns the loaded byte count and line count.
 */
export function memoryIndexCut(
  text: string,
  maxLines: number,
  maxBytes: number,
): { loadedBytes: number; loadedLines: number; cutAtByte: number; totalLines: number } {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  let kept = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : trimmed;
  if (kept.length > maxBytes) {
    const nl = kept.lastIndexOf('\n', maxBytes);
    kept = kept.slice(0, nl > 0 ? nl : maxBytes);
  }
  const lead = text.length - text.trimStart().length;
  const loadedBytes = Buffer.byteLength(kept, 'utf8');
  return {
    loadedBytes,
    loadedLines: kept === '' ? 0 : kept.split('\n').length,
    cutAtByte: Buffer.byteLength(text.slice(0, lead), 'utf8') + loadedBytes,
    totalLines: trimmed === '' ? 0 : lines.length,
  };
}

/** `paths:` frontmatter of a rule → globs (trailing `/**` dropped); undefined = unconditional. */
export function ruleGlobs(paths: unknown): string[] | undefined {
  const raw =
    typeof paths === 'string'
      ? paths.split(',')
      : Array.isArray(paths)
        ? paths.filter((x): x is string => typeof x === 'string')
        : [];
  const globs = raw
    .map((g) => g.trim())
    .map((g) => (g.endsWith('/**') ? g.slice(0, -3) : g))
    .filter((g) => g.length > 0);
  if (globs.length === 0 || globs.every((g) => g === '**')) return undefined;
  return globs;
}
