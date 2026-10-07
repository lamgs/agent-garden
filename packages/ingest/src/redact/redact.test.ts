import { describe, expect, it } from 'vitest';
import { Redactor, isSensitivePath } from './index';
import { plantedSecrets } from './planted-secrets';

const r = () => new Redactor(Buffer.alloc(32, 7));

describe('redactor: every planted secret kind is removed', () => {
  for (const p of plantedSecrets()) {
    it(p.kind, () => {
      const out = r().text(p.context);
      expect(out).not.toContain(p.secret);
      expect(out).toMatch(/\[REDACTED:[a-z0-9_]+:[0-9a-f]{8}\]/);
    });
  }
  it('secret fragments do not survive (no 12+ char substring of a secret remains)', () => {
    for (const p of plantedSecrets('frag')) {
      const out = r().text(p.context);
      const core = p.secret.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
      for (let i = 0; i + 12 <= core.length; i += 6)
        expect(out).not.toContain(core.slice(i, i + 12));
    }
  });
});

describe('redactor: keeps ordinary code readable', () => {
  const keep = [
    'const tokenCount = usage.output_tokens',
    'const password = process.env.DB_PASSWORD',
    'git commit -m "fix token refresh"',
    'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'commit 3e1b5c7a9d2f4e6b8a0c1d3e5f7a9b1c3d5e7f9a',
    'session 85b0c0f1-3c55-4d6e-9e2b-0f6a2c1d7e9b',
    'export function redactSecrets(text: string) {}',
    'password: "${DB_PASSWORD}"',
    'API_KEY=<your key here>',
    'tokens: parse(r.tokens_json)',
    'const secrets = plantedSecrets(tag)',
    'const secret = caps[d.group - 1]',
    'peakContextTokens: Number(r.peak_context_tokens)',
    'DATABASE_URL=postgres://app:${DB_PASS}@localhost/db',
  ];
  for (const line of keep) it(line, () => expect(r().text(line)).toBe(line));
});

describe('redactor: tags', () => {
  it('same secret gets the same tag under one key, different under another', () => {
    const [p] = plantedSecrets();
    const a = r().text(p!.context);
    expect(r().text(p!.context)).toBe(a);
    expect(new Redactor(Buffer.alloc(32, 9)).text(p!.context)).not.toBe(a);
  });
  it('counts by kind', () => {
    const red = r();
    red.text(
      plantedSecrets()
        .map((p) => p.context)
        .join('\n'),
    );
    expect(Object.keys(red.stats.byKind).length).toBeGreaterThanOrEqual(15);
  });
  it('rejects short keys', () => expect(() => new Redactor(Buffer.alloc(4))).toThrow());
});

describe('redactor: truncation happens after redaction', () => {
  it('a secret straddling the truncation point is still fully redacted', () => {
    const [p] = plantedSecrets();
    const text = 'a'.repeat(1990) + ' ' + p!.secret;
    const out = r().text(text, 2000);
    expect(out).not.toContain(p!.secret.slice(0, 10 + 9));
    expect(out).toContain('[REDACTED:anthropic_key');
  });
});

describe('redactor.deep', () => {
  it('redacts every string, replaces env/headers maps, truncates previews', () => {
    const secrets = plantedSecrets('deep');
    const input = {
      name: 'x',
      preview: 'z'.repeat(5000),
      nested: [{ cmd: secrets[0]!.context }],
      mcp: { env: { HARMLESS_LOOKING: 'plainvalue', TOKEN: 'abc' }, headers: { Auth: 'qwerty' } },
      n: 42,
    };
    const out = r().deep<typeof input>(input) as unknown as typeof input;
    const json = JSON.stringify(out);
    expect(json).not.toContain(secrets[0]!.secret);
    expect(json).not.toContain('plainvalue');
    expect(json).not.toContain('qwerty');
    expect(Object.keys(out.mcp.env)).toEqual(['HARMLESS_LOOKING', 'TOKEN']);
    expect(out.preview.length).toBeLessThan(2100);
    expect(out.n).toBe(42);
  });
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    'app/.env.local',
    'certs/server.pem',
    '/home/u/.ssh/id_ed25519',
    '/home/u/.aws/credentials',
    '/home/u/.claude.json',
    'config/secrets.yaml',
  ])('sensitive: %s', (p) => expect(isSensitivePath(p)).toBe(true));
  it.each(['src/env.ts', 'README.md', 'src/secrets-manager.ts', 'docs/keys.md'])(
    'not sensitive: %s',
    (p) => expect(isSensitivePath(p)).toBe(false),
  );
});
