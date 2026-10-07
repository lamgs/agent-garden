/**
 * Command matchers for loop tiers and outcome detectors. Each matcher looks at the head of every
 * simple command in a Bash line (after env prefixes and wrappers like `npx` / `uv run`), never at
 * raw substrings: `cd app && pnpm test -- --run` is a test command, `echo "pnpm test"` and
 * `cat test.log` are not.
 */
import { basename, parseShell, positionals, unwrap, type SimpleCommand } from './shell';

/** Tools that are a test runner, linter, or type checker by themselves. */
const CHECK_TOOLS = new Set([
  'pytest',
  'py.test',
  'unittest',
  'nose2',
  'tox',
  'nox',
  'jest',
  'vitest',
  'mocha',
  'ava',
  'karma',
  'jasmine',
  'tsc',
  'vue-tsc',
  'svelte-check',
  'eslint',
  'oxlint',
  'stylelint',
  'mypy',
  'pyright',
  'basedpyright',
  'flake8',
  'pylint',
  'rspec',
  'rubocop',
  'phpunit',
  'pest',
  'phpstan',
  'psalm',
  'golangci-lint',
  'staticcheck',
  'shellcheck',
  'hadolint',
  'ctest',
  'detekt',
  'ktlint',
  'swiftlint',
]);

/** `<tool> <subcommand>` pairs that run checks. */
const CHECK_SUBCOMMANDS: Record<string, readonly string[]> = {
  go: ['test', 'vet'],
  cargo: ['test', 'clippy', 'check', 'nextest', 'fmt'],
  deno: ['test', 'lint', 'check'],
  swift: ['test'],
  dotnet: ['test'],
  mix: ['test', 'credo', 'dialyzer'],
  playwright: ['test'],
  cypress: ['run'],
  biome: ['check', 'lint', 'ci'],
  rake: ['test', 'spec'],
  gradle: ['test', 'check', 'connectedCheck', 'lint'],
  gradlew: ['test', 'check', 'connectedCheck', 'lint'],
  mvn: ['test', 'verify'],
  mvnw: ['test', 'verify'],
  flutter: ['test', 'analyze'],
  dart: ['test', 'analyze'],
  zig: ['test'],
  sbt: ['test'],
};

/** Package-manager script names that run checks (`test`, `test:unit`, `lint-fix`, `typecheck`). */
const CHECK_SCRIPT =
  /^(test|tests|unit|e2e|spec|lint|typecheck|type-check|check-types|types|tsc|check|verify|ci)([:._-].*)?$/i;
/** Make-style targets that run checks. */
const CHECK_TARGET = /^(test|tests|check|lint|typecheck|verify|ci)([:._-].*)?$/i;

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_VALUE_FLAGS: Record<string, readonly string[]> = {
  npm: ['-w', '--workspace', '--prefix', '-C'],
  pnpm: ['--filter', '-F', '-C', '--dir', '--workspace-dir', '--reporter'],
  yarn: ['--cwd'],
  bun: ['--filter', '--cwd', '-F'],
};
/** Package-manager built-in commands that are never scripts. */
const PM_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'up',
  'upgrade',
  'ci',
  'init',
  'create',
  'publish',
  'pack',
  'link',
  'unlink',
  'list',
  'ls',
  'outdated',
  'audit',
  'why',
  'info',
  'view',
  'config',
  'version',
  'login',
  'logout',
  'whoami',
  'cache',
  'store',
  'prune',
  'dedupe',
]);

/** Resolve the script/bin a package-manager invocation runs, e.g. `pnpm -F web run test:unit`. */
function packageScript(
  argv: readonly string[],
): { script: string; rest: string[]; viaRun: boolean } | null {
  const pm = basename(argv[0] as string);
  const args = argv.slice(1);
  const valueFlags = PM_VALUE_FLAGS[pm] ?? [];
  let i = 0;
  const next = (): string | undefined => {
    for (; i < args.length; i++) {
      const a = args[i] as string;
      if (a === '--') return undefined;
      if (a.startsWith('-')) {
        if (valueFlags.includes(a)) i++;
        continue;
      }
      return args[i++];
    }
    return undefined;
  };
  let word = next();
  if (word === undefined) return null;
  if (pm === 'yarn' && word === 'workspace') {
    next(); // workspace name
    word = next();
  } else if (pm === 'yarn' && word === 'workspaces' && args[i] === 'foreach') {
    i++;
    word = next();
  }
  const viaRun = word === 'run' || word === 'run-script';
  if (viaRun) word = next();
  if (word === undefined) return null;
  if (pm === 'npm' && word === 't') word = 'test';
  if (pm === 'pnpm' && word === 't') word = 'test';
  return { script: word, rest: args.slice(i), viaRun };
}

function isCheckArgv(argvIn: readonly string[]): boolean {
  const argv = unwrap(argvIn);
  if (argv.length === 0) return false;
  const head = basename(argv[0] as string);
  const args = argv.slice(1);

  if (CHECK_TOOLS.has(head)) return true;
  if (head === 'ruff') {
    const [sub] = positionals(args);
    return sub !== 'format' || args.includes('--check');
  }
  if (head === 'black' || head === 'prettier' || head === 'gofmt' || head === 'isort') {
    return args.some(
      (a) => a === '--check' || a === '-c' || a === '-l' || a === '--list-different',
    );
  }
  const subs = CHECK_SUBCOMMANDS[head];
  if (subs !== undefined) {
    const [sub] = positionals(args, ['-p', '--package', '--manifest-path', '-C']);
    if (sub === undefined) return false;
    if (head === 'cargo' && sub === 'fmt') return args.includes('--check');
    return subs.includes(sub);
  }
  if (head === 'make' || head === 'just' || head === 'task' || head === 'mise') {
    const targets = positionals(args, ['-C', '-f', '--directory', '--file', '-j']);
    const t = head === 'mise' && targets[0] === 'run' ? targets[1] : targets[0];
    return t !== undefined && CHECK_TARGET.test(t);
  }
  if (head === 'php' && args[0] === 'artisan' && args[1] === 'test') return true;
  if (PACKAGE_MANAGERS.has(head)) {
    const resolved = packageScript(argv);
    if (resolved === null) return false;
    if (!resolved.viaRun && PM_BUILTINS.has(resolved.script)) return false;
    if (resolved.script === 'exec' || resolved.script === 'dlx' || resolved.script === 'x') {
      return isCheckArgv(resolved.rest);
    }
    if (head === 'bun' && resolved.script === 'test') return true;
    return CHECK_SCRIPT.test(resolved.script) || CHECK_TOOLS.has(resolved.script);
  }
  return false;
}

/** Runs tests, a linter, or a type checker in any of its simple commands. */
export function isTestCommand(command: string | undefined): boolean {
  if (command === undefined || command.trim() === '') return false;
  return parseShell(command).some((c) => isCheckArgv(c.argv));
}

const GIT_VALUE_FLAGS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];

function gitSub(args: readonly string[]): { sub: string | undefined; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith('-')) {
      if (GIT_VALUE_FLAGS.includes(a)) i++;
      continue;
    }
    return { sub: a, rest: args.slice(i + 1) };
  }
  return { sub: undefined, rest: [] };
}

type ShipKind = 'commit' | 'push' | 'tag' | 'pr' | 'release' | 'deploy' | 'publish';

function shipKind(argvIn: readonly string[]): ShipKind | null {
  const argv = unwrap(argvIn);
  if (argv.length === 0) return null;
  const head = basename(argv[0] as string);
  const args = argv.slice(1);
  if (args.includes('--dry-run') && (head === 'git' || PACKAGE_MANAGERS.has(head))) return null;
  const pos = positionals(args);
  const [p0, p1] = pos;

  switch (head) {
    case 'git': {
      const { sub, rest } = gitSub(args);
      if (sub === 'commit') return 'commit';
      if (sub === 'push') return 'push';
      if (sub === 'tag') {
        const listing = rest.length === 0 || rest.some((a) => a === '-l' || a === '--list');
        const deleting = rest.some((a) => a === '-d' || a === '--delete');
        return listing || deleting || positionals(rest, ['-m', '-F']).length === 0 ? null : 'tag';
      }
      return null;
    }
    case 'gh':
      if (p0 === 'pr' && (p1 === 'create' || p1 === 'merge')) return 'pr';
      if (p0 === 'release' && (p1 === 'create' || p1 === 'upload')) return 'release';
      return null;
    case 'vercel':
      return p0 === undefined || p0 === 'deploy' || p0 === 'promote' ? 'deploy' : null;
    case 'netlify':
    case 'fly':
    case 'flyctl':
    case 'firebase':
    case 'serverless':
    case 'sls':
    case 'sam':
    case 'cdk':
    case 'eb':
      return p0 === 'deploy' ? 'deploy' : null;
    case 'wrangler':
      return p0 === 'deploy' || p0 === 'publish' ? 'deploy' : null;
    case 'railway':
      return p0 === 'up' ? 'deploy' : null;
    case 'kubectl':
      return p0 === 'apply' || p0 === 'rollout' || p0 === 'replace' ? 'deploy' : null;
    case 'helm':
      return p0 === 'install' || p0 === 'upgrade' ? 'deploy' : null;
    case 'terraform':
    case 'tofu':
      return p0 === 'apply' ? 'deploy' : null;
    case 'pulumi':
      return p0 === 'up' ? 'deploy' : null;
    case 'gcloud':
      return pos.includes('deploy') ? 'deploy' : null;
    case 'docker':
    case 'podman':
      if (p0 === 'push') return 'publish';
      return p0 === 'buildx' && args.includes('--push') ? 'publish' : null;
    case 'cargo':
    case 'poetry':
    case 'uv':
    case 'changeset':
      return p0 === 'publish' ? 'publish' : null;
    case 'twine':
      return p0 === 'upload' ? 'publish' : null;
    case 'gem':
      return p0 === 'push' ? 'publish' : null;
    default:
      if (PACKAGE_MANAGERS.has(head)) {
        if (p0 === 'publish' || (head === 'yarn' && p0 === 'npm' && p1 === 'publish')) {
          return 'publish';
        }
      }
      return null;
  }
}

/** Commits, pushes, tags, opens/merges PRs, releases, deploys, or publishes. */
export function isShipCommand(command: string | undefined): boolean {
  if (command === undefined || command.trim() === '') return false;
  return parseShell(command).some((c) => shipKind(c.argv) !== null);
}

/** The narrower set the `shipped` signal counts: `git commit`, `git push`, `gh pr create`. */
export function isCommitOrPrCommand(command: string | undefined): boolean {
  if (command === undefined || command.trim() === '') return false;
  return parseShell(command).some((c) => {
    const kind = shipKind(c.argv);
    if (kind === 'commit' || kind === 'push') return true;
    if (kind !== 'pr') return false;
    return positionals(unwrap(c.argv).slice(1))[1] === 'create';
  });
}

/** Files a simple command writes: redirections, `tee`, `sed -i`, `cp`/`mv`/`install` targets. */
function writtenFiles(cmd: SimpleCommand): string[] {
  const files = [...cmd.writes];
  const argv = unwrap(cmd.argv);
  if (argv.length === 0) return files;
  const head = basename(argv[0] as string);
  const args = argv.slice(1);
  if (head === 'tee') files.push(...positionals(args));
  if (head === 'sed' && args.some((a) => a === '-i' || a.startsWith('-i'))) {
    const pos = positionals(args, ['-e', '-f']);
    files.push(...pos.slice(args.includes('-e') ? 0 : 1));
  }
  if (head === 'cp' || head === 'mv' || head === 'install' || head === 'ln') {
    const pos = positionals(args, ['-t', '-m', '-o', '-g']);
    const last = pos[pos.length - 1];
    if (pos.length >= 2 && last !== undefined) files.push(last);
  }
  return files;
}

/** True when the Bash command writes to any path for which `pred` holds. */
export function commandWritesTo(
  command: string | undefined,
  pred: (path: string) => boolean,
): boolean {
  if (command === undefined || command.trim() === '') return false;
  return parseShell(command).some((c) => writtenFiles(c).some(pred));
}
