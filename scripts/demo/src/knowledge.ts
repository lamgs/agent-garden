/**
 * Demo knowledge setups (milestone K), in real Claude Code formats (docs/sources.md "Knowledge
 * sources"): rules with `paths:`, subdirectory CLAUDE.md files, the auto-memory folder
 * (`~/.claude/projects/<slug>/memory/MEMORY.md` + topic files), and the transcript records that
 * show what was loaded (`instructions`, `nested_memory`, `relevant_memories`).
 *
 *   shop-api         lean: CLAUDE.md points at the right memory files, MEMORY.md is a short index,
 *                    every topic file is linked, one path-scoped rule, one subdirectory CLAUDE.md.
 *   legacy-monolith  bloated: CLAUDE.md repeats the user CLAUDE.md, imports a runbook that does not
 *                    exist, MEMORY.md is 260 lines (past the 200-line cap) with a link past the cap,
 *                    and one memory file nothing points to.
 *
 * Attachment lines use deterministic uuids and a fixed clock step (no RNG draws), so adding them
 * leaves every other line of the dataset, and the story numbers, unchanged.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userClaudeMd } from './config';

/** Lines from the user CLAUDE.md that the legacy CLAUDE.md repeats verbatim (duplicate passages). */
export const USER_RULES_REPEATED = [
  '- Run the relevant tests before saying something is done.',
  '- Never commit secrets or `.env` files. Never force-push to main.',
  '- When unsure about scope, ask one clarifying question instead of guessing.',
];

/** Appended to shop-api's tight CLAUDE.md: where the memory lives and when to read it. */
export const SHOP_MEMORY_SECTION = `
## Memory
- Testing lessons from past sessions: memory/feedback_testing.md (read before changing tests).
- API decisions and why: memory/project_api_decisions.md.
- Path-scoped rules in \`.claude/rules/\` load only when you touch matching files.
`;

/** Prepended to legacy-monolith's bloated CLAUDE.md. */
export const LEGACY_HEADER = `## House rules (copied from my global file)

${USER_RULES_REPEATED.join('\n')}

## Runbooks
- Incident runbook: @docs/legacy-runbook.md
- Billing quirks are in memory/billing_quirks.md.
`;

export interface ProjectKnowledge {
  /** Committed files (rules, subdirectory CLAUDE.md), relative to the repo root. */
  files: Record<string, string>;
  /** Memory folder files (MEMORY.md first). */
  memory: Record<string, string>;
  /** Memory topics recalled in some sessions (relevant_memories). */
  recall: string[];
  /** Subdirectory CLAUDE.md loaded in some sessions (nested_memory), relative to the root. */
  nested?: string;
  /** Unconditional rules (relative), listed in the session-start instructions record. */
  alwaysRules: string[];
}

const topic = (name: string, description: string, type: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body.trim()}\n`;

function legacyIndex(): string {
  const lines = [
    '# Memory index',
    '',
    '- [Billing quirks](billing_quirks_old.md) — superseded, see below',
    '- [Deploy freeze](feedback_deploy_freeze.md) — no deploys on Fridays',
  ];
  const areas = ['billing', 'auth', 'reports', 'mailer', 'jobs', 'orders', 'tax', 'search'];
  let i = 0;
  while (lines.length < 236) {
    const a = areas[i % areas.length]!;
    lines.push(
      `- ${a} note ${String(i + 1).padStart(3, '0')}: remembered while fixing a ${a} bug, the details are in the ticket history`,
    );
    i++;
  }
  lines.push(
    '- [Billing quirks](billing_quirks.md) — rounding, regional tax, and the 2019 cents bug',
  );
  while (lines.length < 260) {
    lines.push(`- late note ${lines.length}: appended after the index was already long`);
  }
  return lines.join('\n') + '\n';
}

export const KNOWLEDGE: Record<string, ProjectKnowledge> = {
  'shop-api': {
    files: {
      '.claude/rules/migrations.md': `---\npaths:\n  - "src/db/**"\n---\n\n# Migrations\n\n- Generate migrations with \`pnpm db:generate\`; never edit files in \`src/db/migrations\` by hand.\n- Every migration needs a down step and a test against \`createTestDb()\`.\n`,
      'src/payments/CLAUDE.md': `# Payments\n\n- Refunds go through \`refunds.ts\` only; it is idempotent on \`refundId\`.\n- Never log card or token fields, even redacted.\n`,
    },
    memory: {
      'MEMORY.md': [
        '# Memory index',
        '',
        '- [Testing lessons](feedback_testing.md) — run one file first; fake timers for retries',
        '- [API decisions](project_api_decisions.md) — why cursors, why 422',
        '- [Release cadence](project_release_cadence.md) — tag on Tuesdays after the nightly',
        '',
      ].join('\n'),
      'feedback_testing.md': topic(
        'Testing lessons',
        'Run the changed test file first, then the suite; use fake timers for retries.',
        'feedback',
        'Run the changed file with `pnpm test -- <file>` first. Why: the full suite takes four minutes. How to apply: only run the suite once the file passes.',
      ),
      'project_api_decisions.md': topic(
        'API decisions',
        'Opaque cursors over offsets; 422 for validation errors.',
        'project',
        'Cursor pagination was chosen in 2026-03 because offsets broke under concurrent inserts. Validation errors return 422 with field errors so the dashboard can highlight inputs.',
      ),
      'project_release_cadence.md': topic(
        'Release cadence',
        'Releases are tagged on Tuesdays after the nightly flaky-test triage.',
        'project',
        'Tag on Tuesdays after the nightly triage is green.',
      ),
    },
    recall: ['feedback_testing.md', 'project_api_decisions.md'],
    nested: 'src/payments/CLAUDE.md',
    alwaysRules: [],
  },
  'legacy-monolith': {
    files: {
      '.claude/rules/billing.md': `# Billing\n\n- remember that money values are integers in cents, never floats\n- In \`billing\`, always check whether the change needs a feature flag before merging.\n`,
    },
    memory: {
      'MEMORY.md': legacyIndex(),
      'billing_quirks.md': topic(
        'Billing quirks',
        'Rounding, regional tax, and the 2019 cents bug.',
        'project',
        'Tax rounds half-even since 2019; invoices before that round half-up. Regional tax comes from `tax.forRegion`.',
      ),
      'feedback_deploy_freeze.md': topic(
        'Deploy freeze',
        'No deploys on Fridays; the on-call rotation is thin.',
        'feedback',
        'Do not deploy on Fridays. Why: the on-call rotation is one person on Fridays.',
      ),
      '2024_migration_notes.md': topic(
        'MySQL 8 migration notes',
        'What broke when the legacy database moved to MySQL 8.',
        'project',
        'Collation changes broke two reports; strict mode rejected zero dates in the jobs table.',
      ),
    },
    recall: ['feedback_deploy_freeze.md'],
    alwaysRules: ['.claude/rules/billing.md'],
  },
};

/** `~/.claude/projects/<slug>`: the path with every non-alphanumeric character replaced by '-'. */
const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
export const memoryDirOf = (claudeHome: string, root: string) =>
  join(claudeHome, 'projects', slug(root), 'memory');

export function writeMemory(claudeHome: string, root: string, project: string): void {
  const k = KNOWLEDGE[project];
  if (!k) return;
  const dir = memoryDirOf(claudeHome, root);
  for (const [name, content] of Object.entries(k.memory)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** Stable small integer from a session id (no RNG draw). */
export const sessionBucket = (sessionId: string, mod: number): number =>
  parseInt(createHash('sha256').update(sessionId).digest('hex').slice(0, 8), 16) % mod;

export interface InstructionsContext {
  claudeHome: string;
  root: string;
  project: string;
  claudeMd: string;
  sessionId: string;
}

/** Session-start knowledge attachments, in order. Content mirrors the files (as Claude Code does). */
export function knowledgeAttachments(c: InstructionsContext): Record<string, unknown>[] {
  const k = KNOWLEDGE[c.project];
  const files: { path: string; type: string; content: string }[] = [
    { path: join(c.claudeHome, 'CLAUDE.md'), type: 'User', content: userClaudeMd() },
    { path: join(c.root, 'CLAUDE.md'), type: 'Project', content: c.claudeMd },
  ];
  for (const r of k?.alwaysRules ?? [])
    files.push({ path: join(c.root, r), type: 'Project', content: k!.files[r] ?? '' });
  const mem = memoryDirOf(c.claudeHome, c.root);
  if (k) files.push({ path: join(mem, 'MEMORY.md'), type: 'AutoMem', content: '(index)' });
  const out: Record<string, unknown>[] = [{ type: 'instructions', files }];
  if (!k) return out;
  const b = sessionBucket(c.sessionId, 6);
  if (k.nested && b % 3 === 0) {
    const p = join(c.root, k.nested);
    out.push({
      type: 'nested_memory',
      path: p,
      content: { path: p, type: 'Project', content: k.files[k.nested] ?? '' },
      displayPath: k.nested,
    });
  }
  const recall = k.recall[b % Math.max(1, k.recall.length + 1)];
  if (recall) {
    const p = join(mem, recall);
    out.push({
      type: 'relevant_memories',
      memories: [
        { path: p, content: k.memory[recall] ?? '', mtimeMs: 1_780_000_000_000, header: recall },
      ],
    });
  }
  return out;
}
