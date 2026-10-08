/**
 * Tokenizer shared by BM25 and the TF-IDF/LSA embedder: camelCase and path splitting, lowercase,
 * English stopwords, and a small deterministic suffix stemmer (not Porter; enough to join
 * test/tests/testing, migrate/migration, plan/planner, review/reviewer).
 */

const STOPWORDS = new Set(
  (
    'a an the and or but nor to of in on at by for with from as into onto about over under ' +
    'it its it’s is are was were be been being am this that these those there here then than ' +
    'i me my mine we us our you your yours he she they them their his her ' +
    'do does did doing done can could should would will shall may might must ' +
    'please pls thanks thank ok okay hey hi so if else not no yes any all some each every ' +
    'what which who whom whose how why where when while ' +
    'let lets now just also too very really quite still again already ' +
    'need needs want wants get gets got make makes made ' +
    'up out off one two only own same other such more most less ' +
    'before after without within via per ' +
    'something anything thing things stuff bit ' +
    // file extensions and path noise
    'ts tsx js jsx py go md mdx json yaml yml src lib internal'
  ).split(/\s+/),
);

const VOWELS = /[aeiouy]/;

/** Light suffix stemmer. Deterministic, idempotent on its own output for common English forms. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);

  let stripped = false;
  if (w.endsWith('ing') && w.length > 5 && VOWELS.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
    stripped = true;
  } else if (w.endsWith('ed') && w.length > 4 && VOWELS.test(w.slice(0, -2))) {
    w = w.slice(0, -2);
    stripped = true;
  } else if (w.endsWith('er') && w.length > 5) {
    w = w.slice(0, -2);
    stripped = true;
  }
  if (stripped && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);

  if (w.endsWith('ation') && w.length > 7) w = w.slice(0, -3);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Text → stemmed content tokens, in order (duplicates kept). */
export function tokenize(text: string): string[] {
  const spaced = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const out: string[] = [];
  for (const raw of spaced.split(' ')) {
    if (raw.length < 2 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Token → count. */
export function termCounts(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
