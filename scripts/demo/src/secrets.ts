/**
 * Fake secrets planted in the demo transcripts so the redaction step has something to catch.
 * Every value is assembled at runtime from fragments and a seeded body: no secret-shaped literal
 * exists in this repository (CLAUDE.md privacy rules).
 */
import { Rng } from './rng';

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export interface DemoSecrets {
  /** Password inside a postgres connection URL (data-pipeline `.env` and the runaway loop error). */
  dbPassword: string;
  dbUrl: string;
  /** Payment-provider live key in data-pipeline's `.env`. */
  paymentKey: string;
  /** Bearer token in a curl command (shop-api). */
  bearerToken: string;
  /** GitHub personal access token in a git remote URL (infra). */
  githubToken: string;
}

export function demoSecrets(seed: number): DemoSecrets {
  const rng = Rng.derive(seed, 'secrets');
  const dbPassword = rng.chars(20, ALNUM);
  const dbUrl = [
    'postgres',
    '://',
    'etl_user',
    ':',
    dbPassword,
    '@',
    'warehouse.acme.internal:5432/events',
  ].join('');
  const paymentKey = ['sk', 'li' + 've', rng.chars(24, ALNUM)].join('_');
  const bearerToken = rng.chars(40, ALNUM);
  const githubToken = ['gh', 'p'].join('') + '_' + rng.chars(36, ALNUM);
  return { dbPassword, dbUrl, paymentKey, bearerToken, githubToken };
}

/** The values a redactor must remove (each must appear in the generated transcripts). */
export function plantedSecretValues(seed: number): string[] {
  const s = demoSecrets(seed);
  return [s.dbPassword, s.paymentKey, s.bearerToken, s.githubToken];
}
