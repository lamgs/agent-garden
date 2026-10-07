/**
 * Harness file contents: agent definitions, skills, settings, CLAUDE.md, MCP config. Formats follow
 * docs/sources.md (frontmatter `name`/`description`/`tools`/`model`; hooks block shape; `.mcp.json`).
 */
import { Rng } from './rng';

export type ModelAlias = 'sonnet' | 'opus' | 'haiku';

export const MODEL_IDS: Record<ModelAlias, string> = {
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
};

export interface AgentDef {
  name: string;
  description: string;
  tools: string[];
  /** `inherit` uses the session model. */
  model: ModelAlias | 'inherit';
  body: string;
}

export interface SkillDef {
  dir: string;
  /** Frontmatter name; omitted means the directory name is used. */
  name?: string;
  description?: string;
  body: string;
}

export interface McpDef {
  name: string;
  command: string;
  args: string[];
  tools: string[];
}

export const BUILTIN_TOOLS = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Skill',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

export const BUILTIN_AGENT_TYPES = ['Explore', 'Plan', 'general-purpose'];

export const skillName = (s: SkillDef): string => s.name ?? s.dir;

export function renderAgent(a: AgentDef): string {
  return [
    '---',
    `name: ${a.name}`,
    `description: ${a.description}`,
    `tools: ${a.tools.join(', ')}`,
    `model: ${a.model}`,
    '---',
    '',
    a.body.trim(),
    '',
  ].join('\n');
}

export function renderSkill(s: SkillDef): string {
  const fm = ['---'];
  if (s.name) fm.push(`name: ${s.name}`);
  if (s.description) fm.push(`description: ${s.description}`);
  fm.push('---', '', s.body.trim(), '');
  return fm.join('\n');
}

export const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';

// ---------------------------------------------------------------------------------------------
// User-level config (~/.claude)
// ---------------------------------------------------------------------------------------------

export const USER_AGENTS: AgentDef[] = [
  {
    name: 'test-writer',
    description:
      'Writes focused unit tests for a module and runs them until they pass. Use after implementing or fixing a change.',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    model: 'inherit',
    body: `You write small, focused unit tests.

1. Read the module under test and its existing tests.
2. Add tests for the behaviour you were asked about, including edge cases.
3. Run only the new or changed test file with the project's test command.
4. Iterate until the tests pass. Never weaken an assertion to make a test pass.
5. Reply with the test file path and a one-line summary per test.`,
  },
  {
    name: 'code-reviewer',
    description:
      'Reviews the current diff for correctness, missing tests, and risky changes. Read-only.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'sonnet',
    body: `Review the working-tree diff (\`git diff\`). Report at most five findings, most severe first.
Each finding: file:line, what is wrong, and a concrete fix. Do not edit files.`,
  },
  {
    name: 'docs-writer',
    description: 'Writes and updates user-facing documentation and API reference pages.',
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Skill'],
    model: 'haiku',
    body: `Write documentation in plain, direct language. Prefer examples over prose.
Keep headings stable so links do not break. Use the api-docs skill for endpoint pages when available.`,
  },
  {
    name: 'migration-helper',
    description:
      'Plans and writes database schema migrations, including backfills and rollback steps.',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Skill'],
    model: 'inherit',
    body: `Write forward and rollback migrations. Large tables need batched backfills.
Always run the migration against the local database and the test suite before reporting back.`,
  },
  {
    name: 'release-manager',
    description: 'Prepares a release: version bump, changelog, tag, and release notes.',
    tools: ['Read', 'Edit', 'Bash', 'Skill'],
    model: 'sonnet',
    body: `Bump the version, update the changelog, create an annotated tag, and push it.
Stop and report if the test suite is red.`,
  },
  {
    // Defined but never used anywhere in the demo data: an orphan (weed).
    name: 'perf-profiler',
    description: 'Profiles slow code paths and proposes optimizations with before/after numbers.',
    tools: ['Read', 'Bash', 'Grep'],
    model: 'opus',
    body: `Measure first. Use the project's benchmark scripts or a profiler, report the top three hotspots,
and propose one change at a time with numbers.`,
  },
];

export const USER_SKILLS: SkillDef[] = [
  {
    // Directory name differs from the frontmatter name, as observed in real data.
    dir: 'changelog',
    name: 'changelog-writer',
    description:
      'Draft a CHANGELOG.md entry from the commits and merged pull requests since the last release tag.',
    body: `Collect commits since the last tag (\`git log <tag>..HEAD --oneline\`), group them into
Added / Changed / Fixed, and write a new section at the top of CHANGELOG.md.`,
  },
  {
    // Near-duplicate of changelog-writer (duplicate weed).
    dir: 'release-notes',
    name: 'release-notes',
    description:
      'Draft a CHANGELOG entry from the commits and merged pull requests since the last release tag.',
    body: `Summarize the commits since the previous tag into release notes grouped by type.`,
  },
  {
    dir: 'tag-release',
    name: 'tag-release',
    description: 'Create and push an annotated git tag for a release after the tests pass.',
    body: `Run \`git tag -a vX.Y.Z -m "vX.Y.Z"\` and \`git push origin vX.Y.Z\`. Refuse if the tests are red.`,
  },
  {
    dir: 'db-migrate',
    name: 'db-migrate',
    description: 'Create, apply, and roll back database migrations with the project tooling.',
    body: `Use the project's migration tool. Always write the down migration. Apply locally, then run tests.`,
  },
  {
    // No description at all (unowned weed).
    dir: 'misc-helpers',
    body: `Assorted shell snippets.

- \`git branch --merged | grep -v main | xargs git branch -d\`
- \`du -sh node_modules\``,
  },
];

export const USER_MCP: McpDef[] = [
  {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    tools: ['create_pull_request', 'get_issue', 'list_pull_requests', 'search_code'],
  },
];

export function userClaudeMd(): string {
  return `# Personal preferences

- I work in TypeScript, Python, and Go. Prefer small, reviewable diffs.
- Run the relevant tests before saying something is done.
- Use conventional commit messages (feat:, fix:, chore:, docs:).
- Never commit secrets or \`.env\` files. Never force-push to main.
- When unsure about scope, ask one clarifying question instead of guessing.
`;
}

export function userSettings(): string {
  return json({
    permissions: {
      allow: ['Bash(git status)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Read(~/notes/**)'],
      deny: ['Read(./.env)', 'Read(./.env.*)'],
    },
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [
            {
              type: 'command',
              command:
                'npx --no-install prettier --write --ignore-unknown "$CLAUDE_FILE_PATHS" >/dev/null 2>&1 || true',
            },
          ],
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------------------------
// CLAUDE.md generation
// ---------------------------------------------------------------------------------------------

const RULES = [
  'always check whether the change needs a feature flag before merging',
  'do not change the public function signatures without updating every caller',
  'keep the old code path until the next release because the mobile app still calls it',
  'log at info level only, debug logs are stripped in production builds',
  'the integration tests need the local database seeded with `make seed` first',
  'prefer the helpers in utils over writing new ones, even if they look old',
  'remember that money values are integers in cents, never floats',
  'dates are stored in UTC but some legacy columns are in US/Eastern, check the column comment',
  'wrap every external call in the retry helper with the default backoff',
  'never import from the internal folder of another module',
  'there is a known race when two workers pick the same job, see the incident notes',
  'run the linter with the legacy config, the new config breaks on generated files',
  'ask before deleting any file, some are loaded dynamically by name',
  'update the API docs and the changelog in the same pull request',
  'mock the payment gateway in tests, never hit the sandbox from CI',
  'the cache keys include the tenant id, forgetting it leaks data across tenants',
  'feature work goes on a branch named after the ticket',
  'the old ORM models are still used by the reporting jobs, do not remove fields',
  'tests in the slow folder are skipped locally, CI runs them nightly',
  'error messages shown to users must come from the translations file',
];

const MODULES = [
  'billing',
  'auth',
  'reports',
  'mailer',
  'jobs',
  'orders',
  'customers',
  'inventory',
  'search',
  'admin',
  'exports',
  'webhooks',
  'tax',
  'shipping',
  'pricing',
  'notifications',
];

/** Deterministic, plausible-but-rambling CLAUDE.md of roughly `bytes` bytes. */
export function bloatedClaudeMd(project: string, bytes: number, seed: number): string {
  const rng = Rng.derive(seed, `claudemd:${project}:${bytes}`);
  const out: string[] = [
    `# ${project}`,
    '',
    'Read this whole file before doing anything. It is long because the codebase is old.',
    '',
    '## Commands',
    '',
    '- Install: `npm ci` (use Node 18, not 20, the native deps break)',
    '- Tests: `npm test` (some suites need `make seed` first)',
    '- Lint: `npm run lint:legacy`',
    '',
  ];
  let size = out.join('\n').length;
  let section = 0;
  while (size < bytes) {
    const mod = MODULES[section % MODULES.length] as string;
    const part =
      section >= MODULES.length ? ` (part ${Math.floor(section / MODULES.length) + 1})` : '';
    const lines = [`## Module notes: ${mod}${part}`, ''];
    const n = rng.int(6, 12);
    for (let i = 0; i < n; i++) {
      lines.push(`- In \`${mod}\`, ${rng.pick(RULES)}.`);
    }
    lines.push('');
    size += lines.join('\n').length + 1;
    out.push(...lines);
    section++;
  }
  return out.join('\n');
}
