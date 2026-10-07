/** Text helpers for the user_* and parent_respawned detectors. Pure, no I/O. */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'can',
  'do',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'so',
  'that',
  'the',
  'this',
  'to',
  'we',
  'with',
  'you',
]);

/** Lowercased word tokens without common stopwords, as a set. */
export function tokenSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_]+(?:['.-][a-z0-9_]+)*/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/** Token Jaccard similarity in [0, 1]. Two empty texts score 0 (no evidence of sameness). */
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Prompt openings that read as "that didn't work". */
export const CORRECTION_START =
  /^\s*(no\b|nope\b|wrong\b|incorrect\b|that'?s not\b|that is not\b|that isn'?t\b|this isn'?t\b|not quite\b|not what\b|still\b|it'?s still\b|it is still\b|doesn'?t work|does not work|didn'?t work|did not work|not working|revert\b|undo\b|try again\b|again\b|that broke\b|this broke\b|you broke\b|why did you\b|why are you\b|stop\b|wait\b|hmm+\b|ugh\b|actually,? (no|that)\b)/i;

/** Phrases anywhere in a prompt that read as a correction. */
export const CORRECTION_ANYWHERE =
  /\b(still (failing|fails|broken|not|doesn'?t|isn'?t|getting|seeing|the same|happening|there)|same (error|issue|problem|result|thing)|(doesn'?t|does not|didn'?t|did not|isn'?t|is not) work(ing)?|not working|(you|that|this) broke|broke (it|the|everything)|that'?s wrong|that is wrong|you (missed|forgot|ignored)|try again|please revert|revert (that|this|it|the|your)|undo (that|this|it|the|your)|that'?s not what|not what i (asked|wanted|meant))\b/i;

/** Reads as a correction of the previous turn. */
export function isCorrection(text: string): boolean {
  return CORRECTION_START.test(text) || CORRECTION_ANYWHERE.test(text);
}

/** Prompt openings that acknowledge the previous turn and move on. */
export const ACKNOWLEDGEMENT_START =
  /^\s*(thanks\b|thank you\b|thx\b|ty\b|great\b|perfect\b|nice\b|awesome\b|excellent\b|cool\b|good job\b|well done\b|works\b|it works\b|that works\b|lgtm\b|looks good\b|looks great\b|sounds good\b|ok(ay)?[,.!]?\s+(now|next|commit|let'?s|great|thanks|good)\b|commit\b|ship it\b|push it\b|now\b|next[,:]?\s|moving on\b|on to\b)/i;

/** Reads as an acknowledgement ("thanks", "lgtm", "ok, now ..."). Corrections never qualify. */
export function isAcknowledgement(text: string): boolean {
  return ACKNOWLEDGEMENT_START.test(text) && !isCorrection(text);
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function truncate(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}
