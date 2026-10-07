/**
 * Secret detectors. Specific formats first, generic key=value last.
 * Each detector replaces either the whole match or one capture group (`group`).
 */
export interface Detector {
  kind: string;
  re: RegExp;
  /** If set, only this capture group is replaced; the rest of the match is kept for readability. */
  group?: number;
  /** Optional filter on the captured secret to reduce false positives. */
  accept?: (secret: string) => boolean;
}

/** Identifier paths like `usage.output_tokens` or `process.env` are code, not secrets. */
const looksLikeCode = (v: string): boolean =>
  // Calls and indexing: `parse(r.tokens_json`, `caps[d.group`. Real secrets don't contain ( or [.
  /^[A-Za-z_$][\w$.]*[([]/.test(v) ||
  // Identifier paths without digits: `usage.output_tokens`, `process.env`.
  (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(v) && !/\d/.test(v));

/** `$VAR`, `${VAR}`, `$(cmd)`: references to a secret, not the secret. */
const ENV_REFERENCE = /^\$[{(]?[A-Za-z_]/;

const PLACEHOLDER =
  /^(x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|true|false|null|none|undefined|changeme)$/i;

export const DETECTORS: readonly Detector[] = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9]{2,10}-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai_key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws_secret_key',
    re: /(aws_secret_access_key|aws_secret_key|secretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi,
    group: 2,
  },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'slack_webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe_key', re: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'huggingface_token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'sendgrid_key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    kind: 'url_credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
    group: 2,
    accept: (v) => !ENV_REFERENCE.test(v),
  },
  {
    kind: 'bearer_token',
    re: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/-]{16,}=*)/g,
    group: 2,
  },
  {
    kind: 'auth_header',
    re: /\b((?:x-api-key|api-key|x-auth-token|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    group: 2,
    accept: (v) =>
      !PLACEHOLDER.test(v) && !ENV_REFERENCE.test(v) && !/^(Bearer|Basic|Token)$/i.test(v),
  },
  {
    // ANTHROPIC_API_KEY=..., "password": "...", client_secret: ..., token = ...
    kind: 'secret_assignment',
    re: /\b([A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|passphrase|access[_-]?key|private[_-]?key|credentials?|auth[_-]?key)[A-Za-z0-9_.-]*["']?\s*(?::|=|=>)\s*["']?)([^\s"',;)}\]]{8,})/gi,
    group: 2,
    accept: (v) =>
      !looksLikeCode(v) &&
      !PLACEHOLDER.test(v) &&
      !ENV_REFERENCE.test(v) &&
      !v.startsWith('[REDACTED'),
  },
];

/**
 * Paths whose file *content* is never stored, even after redaction (tool results of reading them
 * are replaced wholesale).
 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(netrc|pgpass|npmrc|pypirc)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.claude\.json$/i,
  /(^|\/)(secrets?|credentials?)(\.[a-z]+)?$/i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

/** Config map keys whose values are always replaced (key names kept). */
export const ALWAYS_REDACT_MAP_KEYS = new Set(['env', 'headers', 'environment', 'secrets']);
