/**
 * Test helper: format-valid fake secrets, assembled at runtime from fragments so that no literal
 * secret-shaped string exists in the repository (keeps secret scanners quiet and avoids copy-paste
 * of anything that looks real). Bodies are deterministic per kind.
 */
const body = (
  seed: string,
  len: number,
  alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',
) => {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    h = Math.imul(h ^ (i + 7), 2654435761) >>> 0;
    out += alphabet[h % alphabet.length];
  }
  return out;
};
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface PlantedSecret {
  kind: string;
  /** The secret value that must never be stored. */
  secret: string;
  /** Realistic surrounding text in which it appears. */
  context: string;
}

export function plantedSecrets(tag = 'x'): PlantedSecret[] {
  const s = (kind: string, secret: string, context: (v: string) => string): PlantedSecret => ({
    kind,
    secret,
    context: context(secret),
  });
  const b = (k: string, n: number, a?: string) => body(tag + k, n, a);
  return [
    s(
      'anthropic_key',
      ['sk', 'ant', 'api03', b('ant', 48)].join('-'),
      (v) => `export ANTHROPIC_KEY_VALUE=${v}`,
    ),
    s(
      'openai_key',
      ['sk', 'proj', b('oai', 40)].join('-'),
      (v) => `client = OpenAI(api_key="${v}")`,
    ),
    s(
      'aws_access_key',
      'AK' + 'IA' + b('aws', 16, UPPER_DIGITS),
      (v) => `aws_access_key_id = ${v}`,
    ),
    s(
      'aws_secret_key',
      b('awss', 40, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+'),
      (v) => `aws_secret_access_key = ${v}`,
    ),
    s(
      'github_token',
      'gh' + 'p_' + b('gh', 36),
      (v) => `git clone https://github.com/acme/app (token ${v})`,
    ),
    s('github_pat', 'github' + '_pat_' + b('ghpat', 60), (v) => `GH_PAT: ${v}`),
    s('gitlab_token', 'gl' + 'pat-' + b('gl', 20), (v) => `curl --header "PRIVATE-TOKEN: ${v}"`),
    s(
      'slack_token',
      'xo' + 'xb-' + b('sl1', 12, '0123456789') + '-' + b('sl2', 24),
      (v) => `slack.post(token=${v})`,
    ),
    s(
      'slack_webhook',
      'https://hooks.' +
        'slack.com/services/T' +
        b('w1', 8, UPPER_DIGITS) +
        '/B' +
        b('w2', 8, UPPER_DIGITS) +
        '/' +
        b('w3', 24),
      (v) => `webhook: ${v}`,
    ),
    s('google_api_key', 'AI' + 'za' + b('goog', 35), (v) => `maps.js?key=${v}&v=3`),
    s('stripe_key', 'sk' + '_li' + 've_' + b('stripe', 24), (v) => `Stripe(${JSON.stringify(v)})`),
    s('npm_token', 'np' + 'm_' + b('npm', 36), (v) => `//registry.npmjs.org/:_authToken=${v}`),
    s('huggingface_token', 'h' + 'f_' + b('hf', 34), (v) => `huggingface-cli login --token ${v}`),
    s(
      'jwt',
      'ey' + 'J' + b('j1', 20) + '.ey' + 'J' + b('j2', 30) + '.' + b('j3', 43),
      (v) => `{"id_token":"${v}"}`,
    ),
    s(
      'private_key',
      '-----BEGIN RSA ' +
        'PRIVATE KEY-----\n' +
        b('pk', 64) +
        '\n' +
        b('pk2', 64) +
        '\n-----END RSA ' +
        'PRIVATE KEY-----',
      (v) => `cat ~/.ssh/deploy\n${v}\n`,
    ),
    s(
      'url_credentials',
      b('pw', 18),
      (v) => `DATABASE_URL=postgres://app_user:${v}@db.internal:5432/prod`,
    ),
    s(
      'bearer_token',
      b('bearer', 40),
      (v) => `curl -H "Authorization: Bearer ${v}" https://api.example.com`,
    ),
    s('x_api_key', b('xapi', 32), (v) => `fetch(url, { headers: { "x-api-key": "${v}" } })`),
    s('password_assignment', 'Tr0ub4dor' + b('pwd', 10), (v) => `DB_PASSWORD="${v}"`),
    s('generic_secret', b('gen', 32), (v) => `client_secret: ${v}`),
  ];
}
