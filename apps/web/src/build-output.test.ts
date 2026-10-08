/**
 * Privacy gate: the built app must not reference remote resources. URL-shaped strings are allowed
 * only if they are inert identifiers (XML namespaces, React's error-doc link, a Pixi constant).
 * Runtime requests are separately checked by the e2e suite (any non-127.0.0.1 request fails it).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const ALLOWED = [
  /^http:\/\/www\.w3\.org\/(1999\/xlink|2000\/svg|XML\/1998\/namespace|1998\/Math\/MathML)$/,
  /^https:\/\/react\.dev\/errors\/$/,
  /^http:\/\/www\.pixijs\.com\/$/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe.skipIf(!existsSync(DIST))('build output (apps/web/dist)', () => {
  // Read lazily: a skipped describe still runs its body during collection.
  const read = () =>
    files(DIST)
      .filter((f) => /\.(js|css|html|json)$/.test(f))
      .map((f) => ({ f, s: readFileSync(f, 'utf8') }));

  it('contains no URL strings outside the inert allowlist', () => {
    const bad = read().flatMap(({ f, s }) =>
      [...s.matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+/g)]
        .map((m) => m[0].replace(/["'`)\\]+$/, ''))
        .filter((u) => !ALLOWED.some((re) => re.test(u)))
        .map((u) => `${f.replace(DIST, '')}: ${u}`),
    );
    expect(bad).toEqual([]);
  });

  it('loads nothing remote from HTML or CSS (src/href/url())', () => {
    for (const { f, s } of read()) {
      if (f.endsWith('.html')) expect(s).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//);
      if (f.endsWith('.css')) expect(s).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
    }
  });
});
