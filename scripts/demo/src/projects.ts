/**
 * The six demo projects: their harness eras (what is committed to git and when), source files,
 * task subjects, test runners, and the outcome rates the story needs.
 */
import {
  type AgentDef,
  type McpDef,
  type ModelAlias,
  type SkillDef,
  bloatedClaudeMd,
} from './config';
import { KNOWLEDGE, LEGACY_HEADER, SHOP_MEMORY_SECTION } from './knowledge';
import { DAY, HOUR, type Rng, startOfUtcDay } from './rng';

export interface Era {
  from: number;
  /** Commit subject that introduced this era. */
  commit: string;
  model: ModelAlias;
  claudeMd: string;
  testHook?: string;
  allow: string[];
  defaultMode?: string;
  agents: AgentDef[];
  skills: SkillDef[];
  mcp: McpDef[];
  permissionMode: string;
}

export interface Subject {
  name: string;
  file: string;
  testFile: string;
}

export interface TestRunner {
  cmd: (file?: string) => string;
  pass: (file: string, rng: Rng) => string;
  fail: (file: string, rng: Rng) => string;
}

export interface Rates {
  success: number;
  failure: number;
  partial: number;
}

export interface ProjectSpec {
  name: string;
  lang: 'ts' | 'js' | 'py' | 'go' | 'docs';
  eras: Era[];
  /** Mean interactive sessions per weekday (weekends get 15%). */
  sessionsPerWeekday: number;
  effort: string;
  subjects: Subject[];
  /** Undefined: the project has no test command (docs). */
  test?: TestRunner;
  /** Main-thread outcome intent mix at time t. */
  mainRates: (t: number) => Rates;
  /** Subagent spawns in a main work run: [type, probability]. */
  subagents: [string, number][];
  testWriter?: { success: number; respawn: number };
  sourceFiles: Record<string, string>;
  /** Extra non-harness commits: [daysBeforeNow, subject, path, appended line]. */
  sourceCommits: [number, string, string, string][];
  branches: string[];
}

export const eraAt = (p: ProjectSpec, t: number): Era => {
  let e = p.eras[0] as Era;
  for (const x of p.eras) if (x.from <= t) e = x;
  return e;
};

// ---------------------------------------------------------------------------------------------
// Test runner outputs
// ---------------------------------------------------------------------------------------------

const ASSERTIONS = [
  'expected 90 to be 81',
  "expected undefined to deeply equal { code: 'COUPON_EXPIRED' }",
  'expected [] to have a length of 2 but got +0',
  'expected 500 to be 422',
  "Cannot read properties of undefined (reading 'items')",
];

const vitest = (base: string): TestRunner => ({
  cmd: (f) => (f ? `${base} ${f}` : base),
  pass: (f, rng) => {
    const n = rng.int(3, 14);
    return ` RUN  v5.0.3\n\n ✓ ${f} (${n} tests) ${rng.int(8, 90)}ms\n\n Test Files  1 passed (1)\n      Tests  ${n} passed (${n})\n   Duration  ${(rng.int(60, 300) / 100).toFixed(2)}s`;
  },
  fail: (f, rng) => {
    const n = rng.int(4, 12);
    const k = rng.int(1, 3);
    return ` RUN  v5.0.3\n\n ❯ ${f} (${n} tests | ${k} failed) ${rng.int(8, 90)}ms\n   × handles the edge case\n     → AssertionError: ${rng.pick(ASSERTIONS)}\n\n Test Files  1 failed (1)\n      Tests  ${k} failed | ${n - k} passed (${n})`;
  },
});

const jest: TestRunner = {
  cmd: (f) => (f ? `npm test -- ${f}` : 'npm test'),
  pass: (f, rng) => {
    const n = rng.int(3, 9);
    return `> legacy-monolith@4.12.0 test\n> jest --runInBand ${f}\n\nPASS ${f}\nTests:       ${n} passed, ${n} total\nTime:        ${(rng.int(200, 900) / 100).toFixed(2)} s`;
  },
  fail: (f, rng) => {
    const n = rng.int(4, 9);
    const k = rng.int(1, 3);
    const err = rng.pick([
      "TypeError: Cannot read properties of undefined (reading 'lines')",
      "Error: Cannot find module '../../config/legacy.json'",
      'Error: connect ECONNREFUSED 127.0.0.1:3306',
      'expect(received).toEqual(expected) — Expected: 1250, Received: 1249.9999',
    ]);
    return `> legacy-monolith@4.12.0 test\n> jest --runInBand ${f}\n\nFAIL ${f}\n  ● Invoice › totals › applies regional tax\n\n    ${err}\n\nTests:       ${k} failed, ${n - k} passed, ${n} total`;
  },
};

const pytest: TestRunner = {
  cmd: (f) => (f ? `pytest ${f} -q` : 'pytest -q'),
  pass: (_f, rng) =>
    `${'.'.repeat(rng.int(4, 12))}\n${rng.int(4, 12)} passed in ${(rng.int(30, 300) / 100).toFixed(2)}s`,
  fail: (f, rng) =>
    `..F..\n=================================== FAILURES ===================================\nFAILED ${f}::test_handles_late_events - KeyError: 'event_ts'\n1 failed, ${rng.int(3, 9)} passed in ${(rng.int(30, 300) / 100).toFixed(2)}s`,
};

const gotest: TestRunner = {
  cmd: () => 'go test ./...',
  pass: (_f, rng) =>
    `ok  \tgithub.com/acme/infra/internal/plan\t${(rng.int(100, 900) / 1000).toFixed(3)}s\nok  \tgithub.com/acme/infra/internal/drift\t${(rng.int(100, 900) / 1000).toFixed(3)}s\nok  \tgithub.com/acme/infra/internal/cost\t(cached)`,
  fail: (_f, rng) =>
    `--- FAIL: TestDetectDrift (0.0${rng.int(1, 9)}s)\n    detect_test.go:42: expected 2 changed resources, got 3\nFAIL\nFAIL\tgithub.com/acme/infra/internal/drift\t0.311s\nok  \tgithub.com/acme/infra/internal/plan\t(cached)\nFAIL`,
};

// ---------------------------------------------------------------------------------------------
// Project definitions
// ---------------------------------------------------------------------------------------------

const SHOP_TIGHT_CLAUDE_MD = `# shop-api

Acme storefront REST API. Node 22, TypeScript, Fastify, Postgres via Drizzle.

## Commands
- \`pnpm test\` runs vitest. \`pnpm test -- <file>\` runs one file. Always run the tests for the
  file you changed before you say you are done.
- \`pnpm lint\` and \`pnpm typecheck\` must pass before committing.

## Layout
- \`src/<domain>/\` holds routes, services, and \`*.test.ts\` next to the code.
- \`src/middleware/\` holds auth and rate limiting. \`src/db/\` holds schema and migrations.

## Rules
- Money is integer cents. Never use floats for prices.
- Validate request bodies with the zod schemas in \`src/schemas\`. Return 422 with field errors.
- New behaviour needs a test. Bug fixes need a regression test.
- Keep diffs small. One concern per commit, conventional commit messages.
- Do not touch \`src/db/migrations\` by hand; use \`pnpm db:generate\`.

## API conventions
- Routes are versioned under \`/v1\`. Errors use \`{ error: { code, message, fields? } }\`.
- List endpoints paginate with \`limit\` (max 200) and an opaque \`cursor\`.
- Every handler takes the tenant from \`req.auth.tenantId\`; never from the body or query.

## Testing
- Unit tests mock the database with \`createTestDb()\` from \`src/db/testing.ts\`.
- Use fake timers for anything with retries or backoff; real timers make CI flaky.
- A PostToolUse hook runs the related tests after every edit. Read its output.

## When stuck
- Use the test-writer agent for test coverage work.
- Ask before changing a public endpoint's response shape.
${SHOP_MEMORY_SECTION}`;

const NORMAL_RULES: Record<string, string> = {
  'data-pipeline': `# data-pipeline

Nightly ETL that loads storefront events into the Acme warehouse. Python 3.12, uv, pytest.

## Commands
- \`uv run pytest -q\` (or \`pytest -q\` inside the venv). One file: \`pytest tests/test_x.py -q\`.
- \`uv run python -m pipeline.backfill --date YYYY-MM-DD\` re-runs one day.

## Rules
- Steps are idempotent: re-running a day must not duplicate rows.
- Timestamps are UTC. Late events (up to 48h) go to the correction partition.
- Schema changes go through \`pipeline/schemas.py\` and need a migration via the db-migrate skill.
- Never print connection strings. Credentials come from the environment.
`,
  'web-dashboard': `# web-dashboard

Internal analytics dashboard for Acme. React 19, Vite, TanStack Query, vitest + Testing Library.

## Commands
- \`pnpm dev\`, \`pnpm vitest run <file>\`, \`pnpm lint\`.

## Rules
- Components live in \`src/components\`, one component per file, tests next to them.
- Data fetching only through \`src/api/client.ts\`.
- Charts use the shared palette in \`src/theme.ts\`. No inline colors.
- Accessibility: every interactive element needs a label; run the axe check in tests.
`,
  infra: `# infra

Terraform modules and a small Go CLI (\`acme-infra\`) that plans, detects drift, and reports cost.

## Commands
- \`go test ./...\`, \`go vet ./...\`, \`terraform -chdir=envs/staging plan\`.

## Rules
- Never run \`terraform apply\` from an agent session. Plans only.
- Provider versions are pinned in \`versions.tf\`; bump them in a dedicated PR.
- Go code follows the standard layout under \`internal/\`.
`,
  'docs-site': `# docs-site

Public developer docs for the Acme API. Markdown pages under \`docs/\`, built with Astro.

## Commands
- \`npm run build\` must succeed. \`npm run dev\` previews at localhost:4321.

## Rules
- Second person, present tense. Every endpoint page has a curl example and a response example.
- Do not document internal endpoints (anything under \`/internal\`).
`,
};

const mcp = (name: string, command: string, args: string[], tools: string[]): McpDef => ({
  name,
  command,
  args,
  tools,
});

const LEGACY_MCP: McpDef[] = [
  mcp(
    'jira',
    'npx',
    ['-y', '@acme/mcp-jira'],
    ['get_issue', 'search_issues', 'add_comment', 'transition_issue', 'list_sprints'],
  ),
  mcp(
    'confluence',
    'npx',
    ['-y', '@acme/mcp-confluence'],
    ['search_pages', 'get_page', 'create_page', 'update_page'],
  ),
  mcp(
    'sentry',
    'npx',
    ['-y', '@acme/mcp-sentry'],
    ['search_issues', 'get_issue_events', 'resolve_issue', 'list_releases'],
  ),
  mcp(
    'mysql-legacy',
    'uvx',
    ['mcp-mysql', '--read-only'],
    ['query', 'list_tables', 'describe_table'],
  ),
  mcp(
    'datadog',
    'npx',
    ['-y', '@acme/mcp-datadog'],
    ['query_metrics', 'search_logs', 'list_monitors', 'get_dashboard'],
  ),
  mcp(
    'browser',
    'npx',
    ['-y', '@acme/mcp-browser'],
    ['navigate', 'screenshot', 'click', 'fill', 'evaluate'],
  ),
  mcp(
    'slack',
    'npx',
    ['-y', '@acme/mcp-slack'],
    ['post_message', 'search_messages', 'list_channels'],
  ),
];

const RUN_TESTS_SKILL: SkillDef = {
  dir: 'run-tests',
  name: 'run-tests',
  description:
    'Run the shop-api test suite (or one file) and summarize any failures with file:line.',
  body: `Run \`pnpm test\` (or \`pnpm test -- <file>\`). If anything fails, list each failing test with the
assertion message and the most likely cause. Do not fix anything unless asked.`,
};

const API_DOCS_SKILL: SkillDef = {
  dir: 'api-docs',
  name: 'api-docs',
  description: 'Generate or update API reference pages from the OpenAPI spec and route handlers.',
  body: `Read \`openapi.yaml\` and the route handler, then write the reference page with a curl example,
parameters table, and response example.`,
};

const LEGACY_AGENT: AgentDef = {
  name: 'legacy-archaeologist',
  description:
    'Digs through old modules, git blame, and Confluence to explain why legacy code behaves the way it does.',
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'mcp__confluence__search_pages', 'mcp__jira__get_issue'],
  model: 'inherit',
  body: `Explain the history and intent behind legacy code. Cite commits, tickets, or pages. Do not edit files.`,
};

const TERRAFORM_AGENT: AgentDef = {
  name: 'terraform-planner',
  description: 'Runs terraform plan for an environment and summarizes the changes and risks.',
  tools: ['Read', 'Bash', 'Grep'],
  model: 'sonnet',
  body: `Run \`terraform -chdir=envs/<env> plan -no-color\` and summarize adds, changes, and destroys.
Flag anything that replaces a stateful resource. Never apply.`,
};

const subjects = (rows: [string, string, string][]): Subject[] =>
  rows.map(([name, file, testFile]) => ({ name, file, testFile }));

export function buildProjects(now: number, seed: number): ProjectSpec[] {
  const d = storyDates(now);
  // First commit of every repo, well before the 90-day window.
  const before = startOfUtcDay(now) - 130 * DAY + 15 * HOUR;
  const shopSeason = d.shopSeason;
  const dashSkill = d.dashboardSkillAdded;
  const dashModel = d.dashboardModelSwitch;

  const shopApi: ProjectSpec = {
    name: 'shop-api',
    lang: 'ts',
    sessionsPerWeekday: 2.3,
    effort: 'high',
    eras: [
      {
        from: before,
        commit: 'Initial commit',
        model: 'sonnet',
        claudeMd: bloatedClaudeMd('shop-api', 11_500, seed),
        allow: ['Bash(git status)'],
        agents: [],
        skills: [RUN_TESTS_SKILL],
        mcp: [],
        permissionMode: 'default',
      },
      {
        from: shopSeason,
        commit: 'Tighten CLAUDE.md and add test hook',
        model: 'sonnet',
        claudeMd: SHOP_TIGHT_CLAUDE_MD,
        testHook: 'pnpm test --silent --changed 2>&1 | tail -20',
        allow: [
          'Bash(pnpm test:*)',
          'Bash(pnpm lint)',
          'Bash(pnpm typecheck)',
          'Bash(git commit:*)',
        ],
        defaultMode: 'acceptEdits',
        agents: [],
        skills: [RUN_TESTS_SKILL],
        mcp: [],
        permissionMode: 'acceptEdits',
      },
    ],
    subjects: subjects([
      ['cart totals', 'src/cart/totals.ts', 'src/cart/totals.test.ts'],
      ['coupon validation', 'src/coupons/validate.ts', 'src/coupons/validate.test.ts'],
      ['order webhooks', 'src/webhooks/orders.ts', 'src/webhooks/orders.test.ts'],
      ['inventory sync', 'src/inventory/sync.ts', 'src/inventory/sync.test.ts'],
      ['refund flow', 'src/payments/refunds.ts', 'src/payments/refunds.test.ts'],
      ['rate limiter', 'src/middleware/rateLimit.ts', 'src/middleware/rateLimit.test.ts'],
      ['auth middleware', 'src/middleware/auth.ts', 'src/middleware/auth.test.ts'],
      ['product search', 'src/products/search.ts', 'src/products/search.test.ts'],
    ]),
    test: vitest('pnpm test --'),
    mainRates: (t) =>
      t < shopSeason
        ? { success: 0.32, failure: 0.55, partial: 0.13 }
        : { success: 0.8, failure: 0.13, partial: 0.07 },
    subagents: [
      ['test-writer', 0.3],
      ['code-reviewer', 0.12],
      ['Explore', 0.12],
    ],
    testWriter: { success: 0.9, respawn: 0.1 },
    sourceFiles: {
      ...KNOWLEDGE['shop-api']!.files,
      'package.json': `{\n  "name": "shop-api",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "test": "vitest run",\n    "lint": "eslint .",\n    "typecheck": "tsc --noEmit"\n  }\n}\n`,
      'src/cart/totals.ts': `export interface Line { sku: string; qty: number; unitCents: number }\n\nexport function subtotal(lines: Line[]): number {\n  return lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);\n}\n`,
      'src/cart/totals.test.ts': `import { expect, test } from 'vitest';\nimport { subtotal } from './totals';\n\ntest('sums lines', () => {\n  expect(subtotal([{ sku: 'A', qty: 2, unitCents: 500 }])).toBe(1000);\n});\n`,
      'src/coupons/validate.ts': `export function isExpired(expiresAt: Date, now = new Date()): boolean {\n  return expiresAt.getTime() < now.getTime();\n}\n`,
      'src/middleware/rateLimit.ts': `const WINDOW_MS = 60_000;\nexport const limits = { anonymous: 60, authenticated: 600, windowMs: WINDOW_MS };\n`,
      'CHANGELOG.md': `# Changelog\n\n## v1.3.0\n\n- Initial public API.\n`,
    },
    sourceCommits: [
      [110, 'feat(cart): add subtotal helper', 'src/cart/totals.ts', '// subtotal in cents'],
      [
        84,
        'fix(coupons): treat expiry as exclusive',
        'src/coupons/validate.ts',
        '// exclusive bound',
      ],
      [52, 'chore: bump vitest', 'package.json', ''],
      [27, 'feat(rate-limit): per-tenant buckets', 'src/middleware/rateLimit.ts', '// per tenant'],
      [9, 'fix(cart): round discounts half-up', 'src/cart/totals.ts', '// half-up rounding'],
    ],
    branches: [
      'main',
      'main',
      'main',
      'feat/cart-discounts',
      'fix/coupon-expiry',
      'feat/tenant-limits',
    ],
  };

  const legacy: ProjectSpec = {
    name: 'legacy-monolith',
    lang: 'js',
    sessionsPerWeekday: 1.5,
    effort: 'xhigh',
    eras: [
      {
        from: before,
        commit: 'Initial commit',
        model: 'opus',
        claudeMd: LEGACY_HEADER + '\n' + bloatedClaudeMd('legacy-monolith', 30_500, seed),
        allow: ['Bash(npm test:*)', 'mcp__jira', 'mcp__confluence', 'mcp__sentry'],
        agents: [LEGACY_AGENT],
        skills: [],
        mcp: LEGACY_MCP,
        permissionMode: 'default',
      },
    ],
    subjects: subjects([
      ['invoice totals', 'lib/billing/invoice.js', 'test/billing/invoice.test.js'],
      ['session handling', 'lib/auth/session.js', 'test/auth/session.test.js'],
      ['report export', 'lib/reports/export.js', 'test/reports/export.test.js'],
      ['email templates', 'lib/mailer/templates.js', 'test/mailer/templates.test.js'],
      ['job scheduler', 'lib/jobs/scheduler.js', 'test/jobs/scheduler.test.js'],
      ['order import', 'lib/orders/import.js', 'test/orders/import.test.js'],
      ['tax rules', 'lib/billing/tax.js', 'test/billing/tax.test.js'],
      ['customer search', 'lib/customers/search.js', 'test/customers/search.test.js'],
    ]),
    test: jest,
    mainRates: () => ({ success: 0.36, failure: 0.5, partial: 0.14 }),
    subagents: [
      ['test-writer', 0.5],
      ['legacy-archaeologist', 0.12],
      ['Explore', 0.15],
      ['Plan', 0.06],
    ],
    testWriter: { success: 0.3, respawn: 0.55 },
    sourceFiles: {
      ...KNOWLEDGE['legacy-monolith']!.files,
      'package.json': `{\n  "name": "legacy-monolith",\n  "version": "4.12.0",\n  "private": true,\n  "scripts": {\n    "test": "jest --runInBand",\n    "lint:legacy": "eslint -c .eslintrc.legacy.js lib"\n  }\n}\n`,
      'lib/billing/invoice.js': `'use strict';\nconst tax = require('./tax');\n\nfunction total(invoice) {\n  var sum = 0;\n  for (var i = 0; i < invoice.lines.length; i++) sum += invoice.lines[i].amount;\n  return sum + tax.forRegion(invoice.region, sum);\n}\n\nmodule.exports = { total: total };\n`,
      'lib/billing/tax.js': `'use strict';\nvar RATES = { US: 0.07, EU: 0.2, UK: 0.2 };\nexports.forRegion = function (region, amount) {\n  return Math.round(amount * (RATES[region] || 0));\n};\n`,
      'lib/jobs/scheduler.js': `'use strict';\n// TODO(2019): replace with a real queue\nmodule.exports = function schedule(job, everyMs) {\n  return setInterval(job, everyMs);\n};\n`,
    },
    sourceCommits: [
      [101, 'Fix rounding in tax.forRegion', 'lib/billing/tax.js', '// round half even?'],
      [63, 'Hotfix: scheduler double-runs', 'lib/jobs/scheduler.js', '// guard against overlap'],
      [22, 'Invoice: skip zero lines', 'lib/billing/invoice.js', '// skip zero lines'],
    ],
    branches: ['master', 'master', 'hotfix/invoice-rounding', 'feature/BILL-2231'],
  };

  const pipeline: ProjectSpec = {
    name: 'data-pipeline',
    lang: 'py',
    sessionsPerWeekday: 0.9,
    effort: 'high',
    eras: [
      {
        from: before,
        commit: 'Initial commit',
        model: 'sonnet',
        claudeMd: NORMAL_RULES['data-pipeline'] as string,
        allow: ['Bash(pytest:*)', 'Bash(uv run:*)'],
        agents: [],
        skills: [],
        mcp: [],
        permissionMode: 'default',
      },
    ],
    subjects: subjects([
      ['events loader', 'pipeline/load_events.py', 'tests/test_load_events.py'],
      ['dedupe step', 'pipeline/dedupe.py', 'tests/test_dedupe.py'],
      ['schema registry', 'pipeline/schemas.py', 'tests/test_schemas.py'],
      ['backfill job', 'pipeline/backfill.py', 'tests/test_backfill.py'],
      ['currency conversion', 'pipeline/fx.py', 'tests/test_fx.py'],
      ['sessionization', 'pipeline/sessions.py', 'tests/test_sessions.py'],
    ]),
    test: pytest,
    mainRates: () => ({ success: 0.62, failure: 0.25, partial: 0.13 }),
    subagents: [
      ['migration-helper', 0.12],
      ['Explore', 0.12],
      ['general-purpose', 0.06],
    ],
    sourceFiles: {
      'pyproject.toml': `[project]\nname = "data-pipeline"\nversion = "0.9.0"\nrequires-python = ">=3.12"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`,
      'pipeline/__init__.py': '',
      'pipeline/dedupe.py': `def dedupe(rows):\n    seen = set()\n    for row in rows:\n        key = (row["event_id"], row["event_ts"])\n        if key not in seen:\n            seen.add(key)\n            yield row\n`,
      'pipeline/backfill.py': `import argparse\n\n\ndef main():\n    parser = argparse.ArgumentParser()\n    parser.add_argument("--date", required=True)\n    args = parser.parse_args()\n    print(f"backfilling {args.date}")\n\n\nif __name__ == "__main__":\n    main()\n`,
      'tests/test_dedupe.py': `from pipeline.dedupe import dedupe\n\n\ndef test_dedupe_keeps_first():\n    rows = [{"event_id": 1, "event_ts": 0}, {"event_id": 1, "event_ts": 0}]\n    assert len(list(dedupe(rows))) == 1\n`,
    },
    sourceCommits: [
      [95, 'Add dedupe step', 'pipeline/dedupe.py', '# keyed on (event_id, event_ts)'],
      [40, 'Backfill: accept --date', 'pipeline/backfill.py', '# --date YYYY-MM-DD'],
      [12, 'Late events go to correction partition', 'pipeline/dedupe.py', '# late events'],
    ],
    branches: ['main', 'main', 'feat/late-events'],
  };

  const dashboard: ProjectSpec = {
    name: 'web-dashboard',
    lang: 'ts',
    sessionsPerWeekday: 1.2,
    effort: 'high',
    eras: [
      {
        from: before,
        commit: 'Initial commit',
        model: 'opus',
        claudeMd: NORMAL_RULES['web-dashboard'] as string,
        allow: ['Bash(pnpm vitest:*)', 'Bash(pnpm lint)'],
        agents: [],
        skills: [],
        mcp: [],
        permissionMode: 'default',
      },
      {
        from: dashSkill,
        commit: 'Add api-docs skill',
        model: 'opus',
        claudeMd: NORMAL_RULES['web-dashboard'] as string,
        allow: ['Bash(pnpm vitest:*)', 'Bash(pnpm lint)'],
        agents: [],
        skills: [API_DOCS_SKILL],
        mcp: [],
        permissionMode: 'default',
      },
      {
        from: dashModel,
        commit: 'Switch default model to sonnet',
        model: 'sonnet',
        claudeMd: NORMAL_RULES['web-dashboard'] as string,
        allow: ['Bash(pnpm vitest:*)', 'Bash(pnpm lint)'],
        agents: [],
        skills: [API_DOCS_SKILL],
        mcp: [],
        permissionMode: 'default',
      },
    ],
    subjects: subjects([
      ['revenue chart', 'src/components/RevenueChart.tsx', 'src/components/RevenueChart.test.tsx'],
      ['filters panel', 'src/components/FiltersPanel.tsx', 'src/components/FiltersPanel.test.tsx'],
      ['date range picker', 'src/components/DateRange.tsx', 'src/components/DateRange.test.tsx'],
      ['orders table', 'src/components/OrdersTable.tsx', 'src/components/OrdersTable.test.tsx'],
      ['API client', 'src/api/client.ts', 'src/api/client.test.ts'],
      ['auth guard', 'src/routes/AuthGuard.tsx', 'src/routes/AuthGuard.test.tsx'],
    ]),
    test: vitest('pnpm vitest run'),
    mainRates: () => ({ success: 0.66, failure: 0.22, partial: 0.12 }),
    subagents: [
      ['code-reviewer', 0.12],
      ['docs-writer', 0.08],
      ['Explore', 0.1],
      ['release-manager', 0.03],
    ],
    sourceFiles: {
      'package.json': `{\n  "name": "web-dashboard",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run",\n    "lint": "eslint ."\n  }\n}\n`,
      'src/api/client.ts': `export async function getJson<T>(path: string): Promise<T> {\n  const res = await fetch(\`/api\${path}\`);\n  if (!res.ok) throw new Error(\`GET \${path} failed: \${res.status}\`);\n  return (await res.json()) as T;\n}\n`,
      'src/components/RevenueChart.tsx': `export function RevenueChart({ points }: { points: number[] }) {\n  return <svg role="img" aria-label="Revenue">{points.length}</svg>;\n}\n`,
      'openapi.yaml': `openapi: 3.1.0\ninfo:\n  title: Acme dashboard API\n  version: 0.4.0\npaths: {}\n`,
    },
    sourceCommits: [
      [88, 'feat: revenue chart', 'src/components/RevenueChart.tsx', '// first chart'],
      [47, 'fix: api client error message', 'src/api/client.ts', '// include status'],
      [15, 'feat: orders table pagination', 'src/api/client.ts', '// pagination'],
    ],
    branches: ['main', 'main', 'feat/orders-table'],
  };

  const infra: ProjectSpec = {
    name: 'infra',
    lang: 'go',
    sessionsPerWeekday: 0.6,
    effort: 'high',
    eras: [
      {
        from: before,
        commit: 'Initial commit',
        model: 'sonnet',
        claudeMd: NORMAL_RULES.infra as string,
        allow: ['Bash(go test:*)', 'Bash(terraform plan:*)'],
        agents: [TERRAFORM_AGENT],
        skills: [],
        mcp: [],
        permissionMode: 'default',
      },
    ],
    subjects: subjects([
      ['plan runner', 'internal/plan/runner.go', 'internal/plan/runner_test.go'],
      ['drift detector', 'internal/drift/detect.go', 'internal/drift/detect_test.go'],
      ['cost report', 'internal/cost/report.go', 'internal/cost/report_test.go'],
      ['secret rotation job', 'internal/rotate/rotate.go', 'internal/rotate/rotate_test.go'],
    ]),
    test: gotest,
    mainRates: () => ({ success: 0.6, failure: 0.25, partial: 0.15 }),
    subagents: [
      ['terraform-planner', 0.25],
      ['Plan', 0.1],
      ['general-purpose', 0.05],
    ],
    sourceFiles: {
      'go.mod': `module github.com/acme/infra\n\ngo 1.24\n`,
      'internal/drift/detect.go': `package drift\n\n// Changed returns resources whose planned action is not no-op.\nfunc Changed(actions map[string]string) []string {\n\tvar out []string\n\tfor r, a := range actions {\n\t\tif a != "no-op" {\n\t\t\tout = append(out, r)\n\t\t}\n\t}\n\treturn out\n}\n`,
      'envs/staging/versions.tf': `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.4" }\n  }\n}\n`,
    },
    sourceCommits: [
      [70, 'drift: ignore no-op actions', 'internal/drift/detect.go', '// ignore no-op'],
      [33, 'staging: bump aws provider', 'envs/staging/versions.tf', '# bumped'],
    ],
    branches: ['main', 'main', 'deps/weekly'],
  };

  const docs: ProjectSpec = {
    name: 'docs-site',
    lang: 'docs',
    sessionsPerWeekday: 0.45,
    effort: 'medium',
    eras: [
      {
        from: before,
        commit: 'Initial commit',
        model: 'haiku',
        claudeMd: NORMAL_RULES['docs-site'] as string,
        allow: ['Bash(npm run build)'],
        agents: [],
        skills: [],
        mcp: [],
        permissionMode: 'acceptEdits',
      },
    ],
    subjects: subjects([
      ['getting started guide', 'docs/getting-started.md', ''],
      ['orders API reference', 'docs/api/orders.md', ''],
      ['webhooks guide', 'docs/guides/webhooks.md', ''],
      ['authentication page', 'docs/auth.md', ''],
    ]),
    mainRates: () => ({ success: 0.65, failure: 0.2, partial: 0.15 }),
    subagents: [
      ['docs-writer', 0.3],
      ['Explore', 0.08],
    ],
    sourceFiles: {
      'package.json': `{\n  "name": "docs-site",\n  "private": true,\n  "scripts": { "dev": "astro dev", "build": "astro build" }\n}\n`,
      'docs/getting-started.md': `# Getting started\n\nCreate an API key in the dashboard, then call \`GET /v1/products\`.\n`,
      'docs/api/orders.md': `# Orders\n\n## List orders\n\n\`GET /v1/orders\`\n`,
    },
    sourceCommits: [
      [58, 'docs: orders pagination', 'docs/api/orders.md', '\nSupports `limit` and `cursor`.'],
    ],
    branches: ['main'],
  };

  return [shopApi, legacy, pipeline, dashboard, infra, docs];
}

/** Key dates of the story, for tests and the report. */
export function storyDates(now: number) {
  const day0 = startOfUtcDay(now);
  const at = (daysAgo: number, hour: number, minute = 0) =>
    day0 - daysAgo * DAY + hour * HOUR + minute * 60_000;
  return {
    windowStart: day0 - 90 * DAY,
    shopSeason: at(45, 16, 20),
    dashboardSkillAdded: at(60, 15, 5),
    dashboardModelSwitch: at(30, 17, 40),
    runawayStart: at(10, 5, 0),
    sweepLast: at(35, 6, 0),
  };
}
