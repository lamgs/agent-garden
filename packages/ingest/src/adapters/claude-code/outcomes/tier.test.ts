import { describe, expect, it } from 'vitest';
import type { LoopTier } from '@garden/core';
import type { TierInput } from '../contracts';
import { classifyTier, isHarnessPath } from './tier';
import { commandWritesTo, isCommitOrPrCommand, isShipCommand, isTestCommand } from './commands';
import { parseShell } from './shell';

const bash = (command: string, kind: TierInput['kind'] = 'tool_call'): TierInput => ({
  kind,
  tool: { name: 'Bash', callId: 'c1', category: 'builtin' },
  raw: { command },
});
const edit = (filePath: string, name = 'Edit'): TierInput => ({
  kind: 'tool_call',
  tool: { name, callId: 'c1', category: 'builtin' },
  raw: { filePath },
});

describe('parseShell', () => {
  it('splits on operators and keeps quoted text in one word', () => {
    expect(
      parseShell('cd app && FOO=1 pnpm test -- --run | tee out.log').map((c) => c.argv),
    ).toEqual([
      ['cd', 'app'],
      ['FOO=1', 'pnpm', 'test', '--', '--run'],
      ['tee', 'out.log'],
    ]);
    expect(parseShell('echo "pnpm test; git push"').map((c) => c.argv)).toEqual([
      ['echo', 'pnpm test; git push'],
    ]);
  });
  it('records redirections and drops fd duplication', () => {
    expect(parseShell('pnpm test > out.log 2>&1')).toEqual([
      { argv: ['pnpm', 'test'], writes: ['out.log'] },
    ]);
  });
  it('skips heredoc bodies', () => {
    const c = "cat > CLAUDE.md <<'EOF'\nRun pnpm test before git push\nEOF\nls";
    expect(parseShell(c).map((x) => x.argv)).toEqual([['cat'], ['ls']]);
    expect(parseShell(c)[0]?.writes).toEqual(['CLAUDE.md']);
  });
});

// [command, expected tier]
const COMMANDS: [string, LoopTier][] = [
  // verification
  ['pnpm test', 'verification'],
  ['cd app && pnpm test -- --run', 'verification'],
  ['npm run test:unit', 'verification'],
  ['npm t', 'verification'],
  ['yarn lint', 'verification'],
  ['yarn workspace web test', 'verification'],
  ['pnpm -F web typecheck', 'verification'],
  ['pnpm --filter @app/api run check', 'verification'],
  ['pnpm -r --filter ./packages/core test', 'verification'],
  ['bun test', 'verification'],
  ['bun run lint', 'verification'],
  ['npx vitest run src/foo.test.ts', 'verification'],
  ['pnpm exec tsc --noEmit', 'verification'],
  ['pnpm vitest run', 'verification'],
  ['./node_modules/.bin/jest --ci', 'verification'],
  ['CI=1 NODE_ENV=test npx jest', 'verification'],
  ['env CI=true pnpm test', 'verification'],
  ['pytest -x tests/', 'verification'],
  ['python -m pytest -q', 'verification'],
  ['uv run pytest', 'verification'],
  ['poetry run mypy src', 'verification'],
  ['.venv/bin/pytest tests/test_api.py 2>&1 | tail -20', 'verification'],
  ['ruff check .', 'verification'],
  ['go test ./...', 'verification'],
  ['go vet ./...', 'verification'],
  ['cargo test --workspace', 'verification'],
  ['cargo clippy -- -D warnings', 'verification'],
  ['cargo check', 'verification'],
  ['tsc -p tsconfig.json', 'verification'],
  ['eslint . --fix', 'verification'],
  ['bundle exec rspec spec/models', 'verification'],
  ['vendor/bin/phpunit', 'verification'],
  ['make test', 'verification'],
  ['make -C backend lint', 'verification'],
  ['timeout 120 pnpm test', 'verification'],
  ['prettier --check .', 'verification'],
  ['./gradlew test', 'verification'],
  ['mvn verify', 'verification'],
  ['dotnet test', 'verification'],
  ['npx playwright test', 'verification'],
  ['git status && pnpm test', 'verification'],
  // application
  ['git commit -m "fix: login redirect"', 'application'],
  [
    'git add -A && git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nRun pnpm test\nEOF\n)"',
    'application',
  ],
  ['git push origin main', 'application'],
  ['git -C ../repo push', 'application'],
  ['git tag v1.2.0', 'application'],
  ['gh pr create --title "x" --body "y"', 'application'],
  ['gh pr merge 12 --squash', 'application'],
  ['gh release create v1.0.0', 'application'],
  ['vercel --prod', 'application'],
  ['npx vercel deploy', 'application'],
  ['fly deploy', 'application'],
  ['kubectl apply -f k8s/', 'application'],
  ['terraform apply -auto-approve', 'application'],
  ['npm publish --access public', 'application'],
  ['docker push ghcr.io/me/app:1', 'application'],
  ['pnpm test && git push', 'application'],
  // agent
  ['cat test.log', 'agent'],
  ['echo "pnpm test"', 'agent'],
  ["echo 'run git push later'", 'agent'],
  ['grep -r pytest .', 'agent'],
  ['ls tests/', 'agent'],
  ['pnpm install', 'agent'],
  ['npm ci', 'agent'],
  ['pnpm build', 'agent'],
  ['pnpm dev', 'agent'],
  ['git status', 'agent'],
  ['git diff HEAD~1', 'agent'],
  ['git log --oneline | head', 'agent'],
  ['git tag', 'agent'],
  ['git tag -l "v*"', 'agent'],
  ['git push --dry-run', 'agent'],
  ['gh pr view 12', 'agent'],
  ['gh release list', 'agent'],
  ['ruff format src', 'agent'],
  ['prettier --write .', 'agent'],
  ['vercel env pull', 'agent'],
  ['kubectl get pods', 'agent'],
  ['terraform plan', 'agent'],
  ['docker build -t app .', 'agent'],
  ['cat CLAUDE.md', 'agent'],
  ['# pnpm test\nls', 'agent'],
  // hill_climbing via Bash writes
  ['echo "- run pnpm test" >> CLAUDE.md', 'hill_climbing'],
  ['cat > .claude/agents/reviewer.md <<EOF\nname: reviewer\nEOF', 'hill_climbing'],
  ['echo x | tee -a ~/.claude/CLAUDE.md', 'hill_climbing'],
  ["sed -i 's/a/b/' .claude/settings.json", 'hill_climbing'],
  ['cp template.md .claude/skills/deploy/SKILL.md', 'hill_climbing'],
];

describe('classifyTier: Bash commands', () => {
  it.each(COMMANDS)('%j → %s', (command, tier) => {
    expect(classifyTier(bash(command))).toBe(tier);
  });
  it('classifies tool_results like the call they answer', () => {
    expect(classifyTier(bash('pnpm test', 'tool_result'))).toBe('verification');
    expect(classifyTier(bash('git push', 'tool_result'))).toBe('application');
  });
});

const PATHS: [string, string, LoopTier][] = [
  ['Edit', '/home/u/proj/CLAUDE.md', 'hill_climbing'],
  ['Write', 'CLAUDE.local.md', 'hill_climbing'],
  ['Edit', '/home/u/proj/packages/web/CLAUDE.md', 'hill_climbing'],
  ['Edit', '/home/u/.claude/CLAUDE.md', 'hill_climbing'],
  ['Write', '/home/u/proj/.claude/agents/reviewer.md', 'hill_climbing'],
  ['Write', '/home/u/.claude/agents/planner.md', 'hill_climbing'],
  ['MultiEdit', '/home/u/proj/.claude/skills/release/SKILL.md', 'hill_climbing'],
  ['Edit', '/home/u/proj/.claude/settings.json', 'hill_climbing'],
  ['Edit', '/home/u/proj/.claude/settings.local.json', 'hill_climbing'],
  ['Edit', '/home/u/.claude/settings.json', 'hill_climbing'],
  ['Write', '/home/u/proj/.mcp.json', 'hill_climbing'],
  ['Edit', 'C:\\Users\\u\\proj\\CLAUDE.md', 'hill_climbing'],
  ['Edit', '/home/u/proj/src/app.ts', 'agent'],
  ['Edit', '/home/u/proj/docs/CLAUDE.md.bak', 'agent'],
  ['Edit', '/home/u/proj/MYCLAUDE.md', 'agent'],
  ['Write', '/home/u/proj/agents/notes.md', 'agent'],
  ['Edit', '/home/u/proj/settings.json', 'agent'],
  ['Edit', '/home/u/proj/mcp.json', 'agent'],
  ['Read', '/home/u/proj/CLAUDE.md', 'agent'],
  ['NotebookEdit', '/home/u/proj/.claude/skills/x/demo.ipynb', 'hill_climbing'],
];

describe('classifyTier: file edits', () => {
  it.each(PATHS)('%s %s → %s', (tool, path, tier) => {
    expect(classifyTier(edit(path, tool))).toBe(tier);
  });
});

describe('classifyTier: other steps', () => {
  it('hooks are verification', () => {
    expect(classifyTier({ kind: 'hook', raw: {} })).toBe('verification');
  });
  it('reviewer / tester subagents are verification, others agent', () => {
    const spawn = (
      subagentType: string,
      kind: TierInput['kind'] = 'subagent_spawn',
    ): TierInput => ({
      kind,
      tool: { name: 'Agent', callId: 'c', category: 'subagent' },
      raw: { subagentType },
    });
    expect(classifyTier(spawn('code-reviewer'))).toBe('verification');
    expect(classifyTier(spawn('test-runner'))).toBe('verification');
    expect(classifyTier(spawn('QA'))).toBe('verification');
    expect(classifyTier(spawn('verifier', 'tool_result'))).toBe('verification');
    expect(classifyTier(spawn('Explore'))).toBe('agent');
    expect(classifyTier(spawn('general-purpose'))).toBe('agent');
  });
  it('messages are agent', () => {
    expect(classifyTier({ kind: 'assistant_message', raw: { stopReason: 'end_turn' } })).toBe(
      'agent',
    );
  });
});

describe('command matchers', () => {
  it('isTestCommand handles empty input', () => {
    expect(isTestCommand(undefined)).toBe(false);
    expect(isTestCommand('  ')).toBe(false);
  });
  it('isShipCommand is broad, isCommitOrPrCommand is narrow', () => {
    expect(isShipCommand('gh pr merge 3')).toBe(true);
    expect(isCommitOrPrCommand('gh pr merge 3')).toBe(false);
    expect(isCommitOrPrCommand('gh pr create --fill')).toBe(true);
    expect(isCommitOrPrCommand('git commit -n -m wip')).toBe(true);
    expect(isCommitOrPrCommand('vercel --prod')).toBe(false);
  });
  it('commandWritesTo finds redirect and tee targets', () => {
    expect(commandWritesTo('pnpm test > out.log', (p) => p === 'out.log')).toBe(true);
    expect(commandWritesTo('cat out.log', (p) => p === 'out.log')).toBe(false);
  });
  it('isHarnessPath', () => {
    expect(isHarnessPath(undefined)).toBe(false);
    expect(isHarnessPath('~/.claude/skills/x/SKILL.md')).toBe(true);
  });
});
