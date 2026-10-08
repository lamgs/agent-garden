/**
 * Hand-written router eval over the demo dataset (scripts/demo). Each query is phrased the way a
 * person would ask, NOT copied from the demo's task templates (a test checks that no query equals
 * or contains a demo task preview). `expect` lists the acceptable answers by kind + name; more
 * than one only where the demo genuinely has interchangeable candidates (the changelog-writer /
 * release-notes duplicate) — every such case is commented.
 *
 * Split: every third query (index 2, 5, 8, …) is held out from calibration.
 */

export interface EvalQuery {
  q: string;
  expect: { kind: 'agent' | 'skill'; name: string }[];
  note?: string;
}

const agent = (name: string) => ({ kind: 'agent' as const, name });
const skill = (name: string) => ({ kind: 'skill' as const, name });

export const EVAL_QUERIES: EvalQuery[] = [
  // test-writer
  {
    q: 'I need unit tests around partial refunds in the payments code',
    expect: [agent('test-writer')],
  },
  { q: 'Increase test coverage for coupon expiry edge cases', expect: [agent('test-writer')] },
  {
    q: 'write a spec file for the regional tax calculation in billing',
    expect: [agent('test-writer')],
  },
  // code-reviewer
  {
    q: 'Can someone look over my diff before I push? Check it for bugs',
    expect: [agent('code-reviewer')],
  },
  { q: 'review my rate limiting changes for correctness', expect: [agent('code-reviewer')] },
  {
    q: 'sanity-check this patch for risky changes and anything untested',
    expect: [agent('code-reviewer')],
  },
  // Explore (built-in, no description: only its past tasks describe it)
  {
    q: 'which files implement inventory syncing, and what calls into them?',
    expect: [agent('Explore')],
  },
  {
    q: 'locate the session handling implementation and list its callers',
    expect: [agent('Explore')],
  },
  // Plan (built-in)
  { q: 'Give me a step by step plan for safely changing the cost report', expect: [agent('Plan')] },
  {
    q: 'outline the steps to modify secret rotation without breaking anything',
    expect: [agent('Plan')],
  },
  // legacy-archaeologist
  {
    q: 'Why does the invoice code round taxes like that? Dig into the history',
    expect: [agent('legacy-archaeologist')],
  },
  {
    q: "what's the backstory behind the weird scheduler module, any old tickets or wiki pages?",
    expect: [agent('legacy-archaeologist')],
  },
  // terraform-planner
  {
    q: 'show me what terraform would change in staging and flag anything dangerous',
    expect: [agent('terraform-planner')],
  },
  {
    q: 'dry-run the infrastructure plan for prod and summarize the risks',
    expect: [agent('terraform-planner')],
  },
  // docs-writer
  {
    q: 'refresh the user docs for the filters panel, they are out of date',
    expect: [agent('docs-writer')],
  },
  { q: 'document how the date range picker component behaves now', expect: [agent('docs-writer')] },
  // migration-helper
  {
    q: 'add a partition for late-arriving events to the warehouse schema, with a rollback',
    expect: [agent('migration-helper')],
  },
  {
    q: 'plan a schema change with a batched backfill for a big table',
    expect: [agent('migration-helper')],
  },
  // release-manager
  {
    q: 'ship a new minor version of the dashboard: bump it, changelog, tag',
    expect: [agent('release-manager')],
  },
  // perf-profiler (defined, never run: description only)
  {
    q: 'product search is slow, profile it and find the hotspots with numbers',
    expect: [agent('perf-profiler')],
  },
  // skills
  {
    q: 'run the whole test suite and tell me which tests fail and where',
    expect: [skill('run-tests')],
  },
  {
    q: 'draft release notes from the commits since the last tag',
    // Duplicate skills (the demo's "duplicate" weed): both are correct answers.
    expect: [skill('changelog-writer'), skill('release-notes')],
  },
  {
    q: 'create an annotated git tag for the release and push it once tests are green',
    expect: [skill('tag-release')],
  },
  { q: 'roll back the last database migration', expect: [skill('db-migrate')] },
  {
    q: 'generate the API reference page for an endpoint from openapi.yaml',
    expect: [skill('api-docs')],
  },
  // main thread: ordinary coding work, and the recurring loop tasks
  { q: 'fix the crash in cart totals when the cart is empty', expect: [agent('main')] },
  {
    q: 'validate the request body in the order webhook handler and return field errors',
    expect: [agent('main')],
  },
  {
    q: "yesterday's partition backfill keeps failing, rerun it and fix it",
    expect: [agent('main')],
  },
  {
    q: 'triage the flaky CI tests from last night and open PRs with fixes',
    expect: [agent('main')],
  },
  { q: 'bump our Go module dependencies and the terraform providers', expect: [agent('main')] },
  { q: 'break the drift detector up into smaller functions', expect: [agent('main')] },
];

export type Split = 'calibration' | 'holdout';
export const splitOf = (i: number): Split => (i % 3 === 2 ? 'holdout' : 'calibration');
