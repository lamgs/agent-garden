/**
 * Deterministic synthetic live stream (`?fixture=demo`): emits `LiveMessage`s over virtual time,
 * shaped exactly like GET /api/live/stream (one `snapshot`, then `event` + `agent`, and `gone`).
 *
 * Purely generated values, no real data. It plays the same six harness families (beds) as
 * `garden.demo.json`, and every agent carries the `plantId` of its planting there, so the live
 * layer joins the history layer. Same seed + same `advance` calls → identical messages.
 *
 * Scripted moments in the first minute (then every agent keeps working on seeded random turns):
 *   - shop-api main: a Bash publish waits for permission (inferred after 7 s of silence).
 *   - legacy-monolith main: context near the window, then an auto compaction.
 *   - infra main: `terraform plan` fails (tool error → errored).
 *   - data-pipeline: a headless run triggered by the (flooding) backfill loop; main delegates to
 *     migration-helper, which runs the db-migrate skill.
 *   - web-dashboard main: delegates to code-reviewer and Explore at once; docs-writer uses a skill.
 *   - docs-site main: web research, an edit, then waits for the user's input.
 *   - Edits in hooked beds fire the PostToolUse verification hook (one fails).
 */
import type {
  ID,
  LiveActivity,
  LiveAgent,
  LiveEvent,
  LiveEventKind,
  LiveMessage,
  LiveSnapshot,
  LoopTier,
} from '@garden/core';
import { resolveModelPrice } from '@garden/core';

export const DEMO_START = '2026-10-01T12:00:00.000Z';
/** Silence after a tool_use (no tool_result, no newer lines) before a permission wait is guessed. */
export const PERMISSION_INFER_MS = 7000;
export const ACTIVE_WINDOW_SEC = 300;
export const RECENT_CAP = 60;

type Tool = NonNullable<LiveEvent['tool']>;

/** Tool → live activity, as the transcript live layer classifies it. */
export function activityForTool(tool: Pick<Tool, 'name' | 'category'>): LiveActivity {
  if (tool.category === 'mcp' || tool.name.startsWith('mcp__')) return 'mcp';
  if (tool.category === 'skill' || tool.name === 'Skill') return 'skill';
  if (tool.category === 'subagent' || tool.name === 'Task' || tool.name === 'Agent')
    return 'delegating';
  switch (tool.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'editing';
    case 'Read':
      return 'reading';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'searching';
    case 'Bash':
    case 'BashOutput':
      return 'running';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    default:
      return 'running';
  }
}

// ---- the cast ------------------------------------------------------------------------------

interface BedDef {
  id: ID;
  name: string;
  slug: string;
  model: string;
  /** PostToolUse (Edit|Write) hook configured in this bed. */
  hooked: boolean;
  mcp: string[];
  /** agentName → plantId in garden.demo.json. */
  plants: Record<string, ID>;
  files: string[];
  commands: string[];
}

export const DEMO_BEDS: readonly BedDef[] = [
  {
    id: 'fam_77320afbea5626a6',
    name: 'shop-api',
    slug: 'shop',
    model: 'claude-sonnet-5-5',
    hooked: true,
    mcp: ['github'],
    plants: {
      main: 'plt_ff3cf3eb8c753cda',
      'code-reviewer': 'plt_81ec76c7104d4e0b',
      Explore: 'plt_33d5665ce1f3aa59',
      'test-writer': 'plt_5f39547dea82bd11',
    },
    files: ['src/routes/cart.ts', 'src/db/orders.ts', 'test/cart.test.ts', 'src/auth/session.ts'],
    commands: ['pnpm test', 'pnpm lint', 'git diff --stat'],
  },
  {
    id: 'fam_e4f77dae0177d5e5',
    name: 'legacy-monolith',
    slug: 'legacy',
    model: 'claude-opus-5-5',
    hooked: true,
    mcp: ['mysql-legacy', 'jira', 'confluence', 'sentry', 'github'],
    plants: {
      main: 'plt_74f6b9c8234e6f8e',
      Explore: 'plt_9bf3ced2ad883242',
      'legacy-archaeologist': 'plt_8143e4aa8474a2c2',
      Plan: 'plt_88d143cd7476c408',
      'test-writer': 'plt_0afdf741a0daed53',
    },
    files: ['app/models/invoice.php', 'app/billing/Ledger.php', 'tests/LedgerTest.php'],
    commands: ['vendor/bin/phpunit', 'php -l app/billing/Ledger.php'],
  },
  {
    id: 'fam_c3c543c89ad03831',
    name: 'infra',
    slug: 'infra',
    model: 'claude-sonnet-5-5',
    hooked: true,
    mcp: ['datadog'],
    plants: {
      main: 'plt_7f307d08a4720190',
      'terraform-planner': 'plt_3a3d0cfac546763d',
      Plan: 'plt_cef5c7f6dd6766cd',
      'general-purpose': 'plt_d42d9115bb38528a',
    },
    files: ['modules/vpc/main.tf', 'envs/staging/main.tf', 'modules/rds/variables.tf'],
    commands: ['terraform plan', 'terraform fmt -check', 'tflint'],
  },
  {
    id: 'fam_4a4d4950f87bb9ad',
    name: 'data-pipeline',
    slug: 'pipeline',
    model: 'claude-sonnet-5-5',
    hooked: true,
    mcp: ['postgres', 'datadog'],
    plants: {
      main: 'plt_32694e53104271b2',
      Explore: 'plt_d49177c6346d3b64',
      'migration-helper': 'plt_a26457a692e09521',
      'general-purpose': 'plt_263d60baf6eeb325',
    },
    files: ['dags/events_backfill.py', 'sql/partitions.sql', 'tests/test_backfill.py'],
    commands: ['pytest -q tests/test_backfill.py', 'ruff check dags'],
  },
  {
    id: 'fam_f9fcfe609d8ee649',
    name: 'web-dashboard',
    slug: 'web',
    model: 'claude-sonnet-5-5',
    hooked: true,
    mcp: ['browser'],
    plants: {
      main: 'plt_6598b12d6125172a',
      'code-reviewer': 'plt_e56611089dfa3c3d',
      'docs-writer': 'plt_9621c2475b555fef',
      Explore: 'plt_d007bf482688f822',
      'release-manager': 'plt_6bcece3f7527e70c',
    },
    files: ['src/charts/Revenue.tsx', 'src/hooks/useFilters.ts', 'src/App.tsx'],
    commands: ['pnpm vitest run', 'pnpm typecheck', 'pnpm build'],
  },
  {
    id: 'fam_2a132f4212348a00',
    name: 'docs-site',
    slug: 'docs',
    model: 'claude-haiku-5-5',
    hooked: true,
    mcp: ['github'],
    plants: {
      main: 'plt_f0f59a6a0dc03097',
      'docs-writer': 'plt_f877277e110077ef',
      Explore: 'plt_ca33ce3116070630',
    },
    files: ['docs/getting-started.md', 'docs/api/auth.md', 'mkdocs.yml'],
    commands: ['mkdocs build --strict', 'markdownlint docs'],
  },
];

export const DEMO_LOOPS = {
  backfill: {
    id: 'loop_b865f12b92e54495',
    name: "Backfill yesterday's events partition",
    tier: 'application' as LoopTier,
  },
  flaky: {
    id: 'loop_50471c905c57f8e5',
    name: 'nightly-flaky-triage',
    tier: 'application' as LoopTier,
  },
};

// ---- program ops -----------------------------------------------------------------------------

type Op =
  | { op: 'turn'; preview: string }
  | { op: 'think'; ms: number }
  | { op: 'say'; ms: number; preview: string }
  | {
      op: 'tool';
      tool: Tool;
      ms: number;
      preview: string;
      error?: boolean;
      /** Blocks with no new lines long enough to be inferred as a permission wait. */
      permission?: boolean;
      tokens?: number;
    }
  | { op: 'spawn'; children: { name: string; ops: Op[] }[]; preview: string }
  | { op: 'compact'; ms: number; to: number }
  | { op: 'hook'; pass: boolean; ms: number }
  | { op: 'error'; ms: number; preview: string }
  | { op: 'end'; waitMs: number };

const B = (name: string): Tool => ({ name, category: 'builtin' });
const mcpTool = (server: string, tool: string): Tool => ({
  name: `mcp__${server}__${tool}`,
  category: 'mcp',
  mcpServer: server,
});
const skillTool = (skillName: string): Tool => ({ name: 'Skill', category: 'skill', skillName });
const taskTool: Tool = { name: 'Task', category: 'subagent' };

function rngFor(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type Rng = () => number;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const between = (r: Rng, lo: number, hi: number) => Math.round(lo + r() * (hi - lo));

const PROMPTS = [
  'Fix the failing checkout test and explain the root cause',
  'Add pagination to the orders endpoint',
  'Why is the nightly job slower since Tuesday?',
  'Refactor the session middleware, keep behaviour identical',
  'Write tests for the new discount rules',
  'Review my last commit for edge cases',
  'Update the README for the new config flag',
];

/** One seeded random turn for a main agent in `bed`. */
function randomTurn(r: Rng, bed: BedDef, allowSpawn: boolean): Op[] {
  const ops: Op[] = [
    { op: 'turn', preview: pick(r, PROMPTS) },
    { op: 'think', ms: between(r, 900, 2600) },
  ];
  const steps = between(r, 3, 7);
  for (let i = 0; i < steps; i++) {
    const roll = r();
    const file = pick(r, bed.files);
    if (roll < 0.22) ops.push(tool(B('Read'), between(r, 700, 1800), `Read ${file}`, r));
    else if (roll < 0.36)
      ops.push(
        tool(
          B(pick(r, ['Grep', 'Glob'])),
          between(r, 600, 1500),
          `Grep "${pick(r, ['TODO', 'retry', 'timeout', 'userId'])}"`,
          r,
        ),
      );
    else if (roll < 0.56) {
      ops.push(tool(B('Edit'), between(r, 1200, 3200), `Edit ${file}`, r));
      if (bed.hooked) ops.push({ op: 'hook', pass: r() > 0.12, ms: 500 });
    } else if (roll < 0.7) {
      const cmd = pick(r, bed.commands);
      ops.push({ ...tool(B('Bash'), between(r, 1500, 4200), `Bash ${cmd}`, r), error: r() < 0.1 });
    } else if (roll < 0.78)
      ops.push(
        tool(
          B(pick(r, ['WebFetch', 'WebSearch'])),
          between(r, 1500, 3500),
          'WebFetch docs page',
          r,
        ),
      );
    else if (roll < 0.88 && bed.mcp.length) {
      const server = pick(r, bed.mcp);
      ops.push(
        tool(
          mcpTool(server, pick(r, ['search', 'get_issue', 'query', 'list'])),
          between(r, 1200, 3000),
          `${server}: lookup`,
          r,
        ),
      );
    } else if (roll < 0.94 && allowSpawn) {
      const types = Object.keys(bed.plants).filter((n) => n !== 'main');
      const name = pick(r, types);
      ops.push({
        op: 'spawn',
        preview: `Task → ${name}`,
        children: [{ name, ops: childOps(r, bed, 3) }],
      });
    } else
      ops.push({ op: 'say', ms: between(r, 800, 1800), preview: 'Explaining the change so far' });
    if (r() < 0.5) ops.push({ op: 'think', ms: between(r, 500, 1600) });
  }
  ops.push({ op: 'say', ms: between(r, 900, 1600), preview: 'Summary of what changed and why' });
  ops.push({ op: 'end', waitMs: between(r, 6000, 16000) });
  return ops;
}

function tool(t: Tool, ms: number, preview: string, r: Rng): Extract<Op, { op: 'tool' }> {
  return { op: 'tool', tool: t, ms, preview, tokens: between(r, 1500, 9000) };
}

function childOps(r: Rng, bed: BedDef, n: number): Op[] {
  const ops: Op[] = [{ op: 'think', ms: between(r, 600, 1400) }];
  for (let i = 0; i < n; i++) {
    const file = pick(r, bed.files);
    const roll = r();
    if (roll < 0.4) ops.push(tool(B('Read'), between(r, 700, 1600), `Read ${file}`, r));
    else if (roll < 0.7) ops.push(tool(B('Grep'), between(r, 600, 1400), `Grep in ${file}`, r));
    else ops.push(tool(B('Edit'), between(r, 1000, 2600), `Edit ${file}`, r));
  }
  ops.push({ op: 'say', ms: between(r, 700, 1300), preview: 'Report for the parent agent' });
  return ops;
}

/** The scripted first turn per bed (index into DEMO_BEDS by name). */
function scriptedTurn(bed: BedDef, r: Rng): Op[] {
  const t = (
    x: Tool,
    ms: number,
    preview: string,
    extra: Partial<Extract<Op, { op: 'tool' }>> = {},
  ) => ({
    ...tool(x, ms, preview, r),
    ...extra,
  });
  switch (bed.name) {
    case 'shop-api':
      return [
        { op: 'turn', preview: 'Ship the cart fix as a pre-release' },
        { op: 'think', ms: 1200 },
        t(B('Read'), 1400, 'Read src/routes/cart.ts'),
        t(B('Edit'), 2200, 'Edit src/routes/cart.ts'),
        { op: 'hook', pass: true, ms: 400 },
        t(B('Bash'), 2600, 'Bash pnpm test'),
        { op: 'think', ms: 900 },
        t(B('Bash'), 16000, 'Bash npm publish --tag next', { permission: true }),
        t(mcpTool('github', 'create_pull_request'), 2200, 'github: open pull request'),
        {
          op: 'spawn',
          preview: 'Task → test-writer',
          children: [{ name: 'test-writer', ops: childOps(r, bed, 3) }],
        },
        { op: 'say', ms: 1400, preview: 'Published 2.4.1-next.0 and opened a PR' },
        { op: 'end', waitMs: 9000 },
      ];
    case 'legacy-monolith':
      return [
        { op: 'turn', preview: 'Trace why invoices double-post on retries' },
        { op: 'think', ms: 1800 },
        t(mcpTool('mysql-legacy', 'query'), 2400, 'mysql-legacy: SELECT … FROM ledger_entries'),
        t(mcpTool('jira', 'get_issue'), 1600, 'jira: BILL-2231'),
        {
          op: 'spawn',
          preview: 'Task → legacy-archaeologist',
          children: [
            {
              name: 'legacy-archaeologist',
              ops: [
                { op: 'think', ms: 900 },
                t(B('Grep'), 1300, 'Grep "postInvoice"'),
                t(mcpTool('confluence', 'search'), 2200, 'confluence: ledger design'),
                t(B('Read'), 1500, 'Read app/billing/Ledger.php'),
                { op: 'say', ms: 1000, preview: 'Found the retry path in Ledger::post' },
              ],
            },
          ],
        },
        t(B('Read'), 1600, 'Read app/billing/Ledger.php', { tokens: 30000 }),
        { op: 'compact', ms: 3200, to: 0.16 },
        { op: 'think', ms: 1400 },
        t(B('Edit'), 2600, 'Edit app/billing/Ledger.php'),
        { op: 'hook', pass: false, ms: 500 },
        {
          op: 'spawn',
          preview: 'Task → test-writer',
          children: [
            {
              name: 'test-writer',
              ops: [
                t(B('Read'), 1200, 'Read tests/LedgerTest.php'),
                t(B('Edit'), 2000, 'Edit tests/LedgerTest.php'),
                t(B('Bash'), 2600, 'Bash vendor/bin/phpunit', { error: true }),
                t(B('Bash'), 2400, 'Bash vendor/bin/phpunit', { error: true }),
                { op: 'say', ms: 1000, preview: 'Two tests still fail on fixture dates' },
              ],
            },
          ],
        },
        { op: 'say', ms: 1500, preview: 'Root cause found; tests need fixture fixes' },
        { op: 'end', waitMs: 12000 },
      ];
    case 'infra':
      return [
        { op: 'turn', preview: 'Bump the RDS instance class in staging' },
        { op: 'think', ms: 1000 },
        t(B('Read'), 1300, 'Read envs/staging/main.tf'),
        t(B('Edit'), 1800, 'Edit modules/rds/variables.tf'),
        { op: 'hook', pass: true, ms: 400 },
        t(B('Bash'), 3000, 'Bash terraform plan', { error: true }),
        { op: 'think', ms: 5000 },
        {
          op: 'spawn',
          preview: 'Task → terraform-planner',
          children: [{ name: 'terraform-planner', ops: childOps(r, bed, 3) }],
        },
        t(B('Bash'), 2600, 'Bash terraform plan'),
        { op: 'say', ms: 1200, preview: 'Plan is clean: 1 to change' },
        { op: 'end', waitMs: 10000 },
      ];
    case 'data-pipeline':
      return [
        { op: 'turn', preview: 'Add a partition-pruning migration' },
        { op: 'think', ms: 1400 },
        t(B('Read'), 1400, 'Read sql/partitions.sql'),
        {
          op: 'spawn',
          preview: 'Task → migration-helper',
          children: [
            {
              name: 'migration-helper',
              ops: [
                { op: 'think', ms: 800 },
                t(skillTool('db-migrate'), 3200, 'Skill db-migrate'),
                t(B('Write'), 1800, 'Write sql/migrations/0042_prune.sql'),
                t(mcpTool('postgres', 'query'), 2000, 'postgres: EXPLAIN …'),
                { op: 'say', ms: 1000, preview: 'Migration 0042 drafted and explained' },
              ],
            },
          ],
        },
        t(B('Bash'), 2600, 'Bash pytest -q tests/test_backfill.py'),
        { op: 'say', ms: 1200, preview: 'Migration ready for review' },
        { op: 'end', waitMs: 14000 },
      ];
    case 'web-dashboard':
      return [
        { op: 'turn', preview: 'Review the revenue chart PR and document the filters' },
        { op: 'think', ms: 1100 },
        {
          op: 'spawn',
          preview: 'Task → code-reviewer, Explore',
          children: [
            { name: 'code-reviewer', ops: childOps(r, bed, 4) },
            { name: 'Explore', ops: childOps(r, bed, 3) },
          ],
        },
        t(mcpTool('browser', 'screenshot'), 2200, 'browser: screenshot /revenue'),
        {
          op: 'spawn',
          preview: 'Task → docs-writer',
          children: [
            {
              name: 'docs-writer',
              ops: [
                t(skillTool('api-docs'), 2800, 'Skill api-docs'),
                t(B('Write'), 1800, 'Write docs/filters.md'),
                { op: 'say', ms: 900, preview: 'Filters documented' },
              ],
            },
          ],
        },
        { op: 'say', ms: 1300, preview: 'Two review comments and a docs page' },
        { op: 'end', waitMs: 9000 },
      ];
    case 'docs-site':
    default:
      return [
        { op: 'turn', preview: 'Document the new SSO login flow' },
        { op: 'think', ms: 1000 },
        t(B('WebSearch'), 2400, 'WebSearch "OIDC PKCE flow"'),
        t(B('WebFetch'), 2600, 'WebFetch provider docs'),
        t(B('Edit'), 2200, 'Edit docs/api/auth.md'),
        { op: 'hook', pass: true, ms: 400 },
        { op: 'error', ms: 2400, preview: 'API error 529 (overloaded), retrying' },
        { op: 'say', ms: 1200, preview: 'Draft ready. Which provider should the example use?' },
        { op: 'end', waitMs: 45000 },
      ];
  }
}

function headlessOps(bed: BedDef, r: Rng, loopName: string): Op[] {
  return [
    { op: 'turn', preview: loopName },
    { op: 'think', ms: 900 },
    tool(B('Bash'), 2400, `Bash ${bed.commands[0]}`, r),
    tool(B('Read'), 1200, `Read ${bed.files[0]}`, r),
    { ...tool(B('Bash'), 2200, `Bash ${bed.commands[0]}`, r), error: bed.name === 'data-pipeline' },
    { op: 'say', ms: 900, preview: 'Headless run finished' },
    { op: 'end', waitMs: 0 },
  ];
}

// ---- simulation ------------------------------------------------------------------------------

interface Sim {
  agent: LiveAgent;
  bed: BedDef;
  ops: Op[];
  rng: Rng;
  nextAt: number;
  /** Op in progress whose second half (tool_end, compaction done, …) fires at nextAt. */
  pending: Op | null;
  /** Children this agent waits on (spawn op). */
  waitingOn: Set<ID>;
  /** Permission inference time for a pending tool. */
  permissionAt: number | null;
  kind: 'main' | 'sub' | 'headless';
  /** Time to send `gone` (subagents and headless runs). */
  goneAt: number | null;
  order: number;
}

export interface LiveDemoOptions {
  seed?: number;
  start?: ISOString;
  /** Extra main sessions per bed so the scene holds 30+ agents (performance check). */
  crowd?: boolean;
}
type ISOString = string;

export interface LiveDemo {
  /** Virtual milliseconds since start. */
  now(): number;
  snapshot(): LiveSnapshot;
  /** Advance virtual time and return the messages emitted, in order. */
  advance(ms: number): LiveMessage[];
}

export function createLiveDemo(opts: LiveDemoOptions = {}): LiveDemo {
  const seed = opts.seed ?? 7;
  const startMs = Date.parse(opts.start ?? DEMO_START);
  let now = 0;
  let seq = 0;
  let order = 0;
  let childN = 0;
  const sims = new Map<ID, Sim>();
  const recent: LiveEvent[] = [];
  let out: LiveMessage[] = [];
  const iso = (t: number) => new Date(startMs + t).toISOString();
  const windowOf = (model: string) => resolveModelPrice(model)?.contextWindow ?? 200_000;

  function addSim(
    bed: BedDef,
    key: ID,
    sessionId: ID,
    agentName: string,
    kind: Sim['kind'],
    ops: Op[],
    extra: Partial<LiveAgent> = {},
  ): Sim {
    const win = windowOf(bed.model);
    const rng = rngFor(seed ^ hash(key));
    const agent: LiveAgent = {
      key,
      sessionId,
      agentName,
      agentKind: agentName === 'main' ? 'main' : 'subagent',
      bedId: bed.id,
      bedName: bed.name,
      model: bed.model,
      activity: 'idle',
      activitySince: iso(now),
      lastEventAt: iso(now),
      contextTokens: Math.round(win * (0.04 + rng() * 0.1)),
      contextWindow: win,
      toolCalls: 0,
      errors: 0,
      evidence: 'session file seen; no events yet → idle',
      ...extra,
    };
    const plantId = bed.plants[agentName];
    if (plantId) agent.plantId = plantId;
    const sim: Sim = {
      agent,
      bed,
      ops,
      rng,
      nextAt: now,
      pending: null,
      waitingOn: new Set(),
      permissionAt: null,
      kind,
      goneAt: null,
      order: order++,
    };
    sims.set(key, sim);
    return sim;
  }

  function emit(
    sim: Sim,
    kind: LiveEventKind,
    fields: Partial<Omit<LiveEvent, 'seq' | 'at' | 'kind' | 'agentKey'>> = {},
  ): void {
    const a = sim.agent;
    const ev: LiveEvent = {
      seq: ++seq,
      at: iso(now),
      kind,
      agentKey: a.key,
      contextTokens: a.contextTokens,
      ...fields,
    };
    if (ev.preview) ev.preview = ev.preview.slice(0, 120);
    recent.push(ev);
    if (recent.length > RECENT_CAP) recent.shift();
    a.lastEventAt = ev.at;
    out.push({ type: 'event', event: ev });
  }

  function setActivity(sim: Sim, activity: LiveActivity, evidence: string, detail?: string): void {
    const a = sim.agent;
    if (a.activity !== activity) a.activitySince = iso(now);
    a.activity = activity;
    a.evidence = evidence;
    if (detail === undefined) delete a.detail;
    else a.detail = detail.slice(0, 120);
    out.push({ type: 'agent', agent: structuredClone(a) });
  }

  function grow(sim: Sim, tokens: number): void {
    const a = sim.agent;
    a.contextTokens = Math.min(Math.round(a.contextWindow * 0.97), a.contextTokens + tokens);
  }

  /** Start the next op of `sim`. */
  function startOp(sim: Sim): void {
    const a = sim.agent;
    const op = sim.ops.shift();
    if (!op) return finishProgram(sim);
    switch (op.op) {
      case 'turn':
        a.turnStartedAt = iso(now);
        a.toolCalls = 0;
        a.errors = 0;
        emit(sim, 'turn_start', { preview: op.preview });
        setActivity(
          sim,
          'thinking',
          'user prompt received, no assistant output yet → thinking',
          op.preview,
        );
        sim.nextAt = now + 600;
        return;
      case 'think':
        grow(sim, 400 + Math.floor(sim.rng() * 900));
        emit(sim, 'thinking');
        setActivity(sim, 'thinking', 'thinking block in the newest assistant message → thinking');
        sim.nextAt = now + op.ms;
        return;
      case 'say':
        grow(sim, 300);
        emit(sim, 'assistant_text', { preview: op.preview });
        setActivity(
          sim,
          'thinking',
          'assistant text without a tool call yet → thinking',
          op.preview,
        );
        sim.nextAt = now + op.ms;
        return;
      case 'tool': {
        a.toolCalls += 1;
        a.currentTool = { ...op.tool };
        emit(sim, 'tool_start', { tool: { ...op.tool }, preview: op.preview });
        const act = activityForTool(op.tool);
        setActivity(
          sim,
          act,
          `tool_use ${op.tool.name} without a tool_result yet → ${act}`,
          op.preview,
        );
        sim.pending = op;
        sim.permissionAt = op.permission ? now + PERMISSION_INFER_MS : null;
        sim.nextAt = now + op.ms;
        return;
      }
      case 'spawn': {
        a.toolCalls += 1;
        a.currentTool = { ...taskTool };
        emit(sim, 'tool_start', { tool: { ...taskTool }, preview: op.preview });
        setActivity(
          sim,
          'delegating',
          'tool_use Task (subagent) without a tool_result yet → delegating',
          op.preview,
        );
        for (const c of op.children) {
          const key = `${a.sessionId}:${c.name}:${++childN}`;
          const child = addSim(sim.bed, key, a.sessionId, c.name, 'sub', [...c.ops], {
            parentKey: a.key,
            turnStartedAt: iso(now),
            contextTokens: Math.round(windowOf(sim.bed.model) * 0.02),
          });
          if (a.loop) child.agent.loop = { ...a.loop };
          emit(child, 'subagent_start', { preview: `${c.name} started by ${a.agentName}` });
          setActivity(child, 'thinking', 'subagent transcript started → thinking');
          child.nextAt = now + 400;
          sim.waitingOn.add(key);
        }
        sim.pending = op;
        sim.nextAt = Number.POSITIVE_INFINITY;
        return;
      }
      case 'compact':
        emit(sim, 'compaction', { preview: 'auto compaction' });
        setActivity(sim, 'compacting', 'compact_boundary (auto) in the transcript → compacting');
        sim.pending = op;
        sim.nextAt = now + op.ms;
        return;
      case 'hook':
        emit(sim, 'hook', {
          isError: !op.pass,
          preview: `PostToolUse hook (Edit|Write): ${op.pass ? 'exit 0' : 'exit 1, lint failed'}`,
        });
        out.push({ type: 'agent', agent: structuredClone(a) });
        sim.nextAt = now + op.ms;
        return;
      case 'error':
        a.errors += 1;
        emit(sim, 'error', { isError: true, preview: op.preview });
        setActivity(sim, 'errored', 'API error record in the transcript → errored', op.preview);
        sim.nextAt = now + op.ms;
        return;
      case 'end':
        delete a.currentTool;
        emit(sim, 'turn_end');
        if (sim.kind === 'main') {
          setActivity(
            sim,
            'waiting_input',
            'assistant end_turn with no pending tool → waiting_input (inferred: the transcript records the end of the turn, not that you are needed)',
          );
          sim.nextAt = now + op.waitMs;
        } else {
          setActivity(sim, 'done', 'end of turn in a headless run → done');
          sim.goneAt = now + 4000;
          sim.nextAt = Number.POSITIVE_INFINITY;
        }
        return;
    }
  }

  /** Finish the pending op (second half). */
  function finishPending(sim: Sim): void {
    const a = sim.agent;
    const op = sim.pending;
    sim.pending = null;
    sim.permissionAt = null;
    if (!op) return;
    if (op.op === 'tool') {
      grow(sim, op.tokens ?? 2000);
      const err = op.error === true;
      if (err) a.errors += 1;
      emit(sim, 'tool_end', {
        tool: { ...op.tool },
        isError: err,
        preview: err ? `${op.preview}: exit 1` : op.preview,
      });
      delete a.currentTool;
      if (err)
        setActivity(
          sim,
          'errored',
          `tool_result is_error for ${op.tool.name} → errored`,
          `${op.preview} failed`,
        );
      else setActivity(sim, 'thinking', `tool_result for ${op.tool.name} received → thinking`);
      sim.nextAt = now + (err ? 2600 : 500);
    } else if (op.op === 'spawn') {
      grow(sim, 4000);
      emit(sim, 'tool_end', { tool: { ...taskTool }, preview: 'subagent report received' });
      delete a.currentTool;
      setActivity(sim, 'thinking', 'tool_result for Task (subagent report) received → thinking');
      sim.nextAt = now + 600;
    } else if (op.op === 'compact') {
      a.contextTokens = Math.round(a.contextWindow * op.to);
      setActivity(sim, 'thinking', 'first message after compact_boundary → thinking');
      sim.nextAt = now + 500;
    }
  }

  function finishProgram(sim: Sim): void {
    const a = sim.agent;
    if (sim.kind === 'sub') {
      emit(sim, 'subagent_end', { preview: `${a.agentName} finished` });
      setActivity(sim, 'done', 'subagent transcript ended with a final report → done');
      sim.goneAt = now + 2500;
      sim.nextAt = Number.POSITIVE_INFINITY;
      const parent = a.parentKey ? sims.get(a.parentKey) : undefined;
      if (parent) {
        parent.waitingOn.delete(a.key);
        if (parent.waitingOn.size === 0) parent.nextAt = now + 300;
      }
      return;
    }
    if (sim.kind === 'headless') {
      sim.nextAt = Number.POSITIVE_INFINITY;
      return;
    }
    // Main agents keep working: a fresh seeded turn.
    sim.ops = randomTurn(sim.rng, sim.bed, true);
    startOp(sim);
  }

  function step(sim: Sim): void {
    if (sim.goneAt !== null && now >= sim.goneAt) {
      sims.delete(sim.agent.key);
      out.push({ type: 'gone', agentKey: sim.agent.key });
      return;
    }
    if (sim.permissionAt !== null && now >= sim.permissionAt) {
      sim.permissionAt = null;
      setActivity(
        sim,
        'waiting_permission',
        `tool_use ${sim.agent.currentTool?.name ?? 'tool'} with no tool_result and no newer lines for ${PERMISSION_INFER_MS / 1000} s → waiting_permission (inferred: transcripts do not record permission prompts)`,
        sim.agent.detail,
      );
      return;
    }
    if (sim.pending) finishPending(sim);
    else startOp(sim);
  }

  const dueOf = (s: Sim) =>
    Math.min(
      s.nextAt,
      s.permissionAt ?? Number.POSITIVE_INFINITY,
      s.goneAt ?? Number.POSITIVE_INFINITY,
    );

  // Scheduled loop runs: [first fire ms, period ms, bed, loop].
  const schedules: {
    at: number;
    every: number;
    bed: BedDef;
    loop: (typeof DEMO_LOOPS)['backfill'];
  }[] = [
    { at: 4000, every: 40000, bed: DEMO_BEDS[3]!, loop: DEMO_LOOPS.backfill },
    { at: 30000, every: 90000, bed: DEMO_BEDS[0]!, loop: DEMO_LOOPS.flaky },
  ];
  let headlessN = 0;

  // The cast at t = 0.
  DEMO_BEDS.forEach((bed, i) => {
    const sessionId = `ses_demo_${bed.slug}_1`;
    const sim = addSim(bed, sessionId, sessionId, 'main', 'main', []);
    sim.ops = scriptedTurn(bed, sim.rng);
    if (bed.name === 'legacy-monolith')
      sim.agent.contextTokens = Math.round(sim.agent.contextWindow * 0.86);
    sim.nextAt = 300 + i * 450;
    if (opts.crowd) {
      for (let k = 2; k <= 5; k++) {
        const sid = `ses_demo_${bed.slug}_${k}`;
        const extra = addSim(bed, sid, sid, 'main', 'main', []);
        extra.ops = randomTurn(extra.rng, bed, true);
        extra.nextAt = 500 + k * 700 + i * 130;
      }
    }
  });

  function fireSchedules(target: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const s of schedules) {
      while (s.at <= target) {
        now = Math.max(now, s.at);
        const sid = `ses_demo_${s.bed.slug}_loop${++headlessN}`;
        const sim = addSim(s.bed, sid, sid, 'main', 'headless', [], { loop: { ...s.loop } });
        sim.ops = headlessOps(s.bed, sim.rng, s.loop.name);
        emit(sim, 'session_seen', { preview: `headless run started by ${s.loop.name}` });
        setActivity(
          sim,
          'idle',
          `new transcript with entrypoint sdk-cli, matched loop "${s.loop.name}" → idle`,
        );
        sim.nextAt = now + 800;
        s.at += s.every;
      }
      next = Math.min(next, s.at);
    }
    return next;
  }

  function advance(ms: number): LiveMessage[] {
    out = [];
    const target = now + Math.max(0, ms);
    for (;;) {
      let best: Sim | null = null;
      let bestDue = Number.POSITIVE_INFINITY;
      for (const s of sims.values()) {
        const d = dueOf(s);
        if (d < bestDue || (d === bestDue && best && s.order < best.order)) {
          best = s;
          bestDue = d;
        }
      }
      const nextSchedule = Math.min(...schedules.map((s) => s.at));
      if (nextSchedule <= target && nextSchedule <= bestDue) {
        fireSchedules(nextSchedule);
        continue;
      }
      if (!best || bestDue > target) break;
      now = Math.max(now, bestDue);
      step(best);
    }
    now = target;
    return out;
  }

  function snapshot(): LiveSnapshot {
    return {
      generatedAt: iso(now),
      source: 'demo',
      agents: [...sims.values()]
        .sort((a, b) => a.order - b.order)
        .map((s) => structuredClone(s.agent)),
      activeWindowSec: ACTIVE_WINDOW_SEC,
      recent: recent.map((e) => structuredClone(e)),
    };
  }

  return { now: () => now, snapshot, advance };
}
