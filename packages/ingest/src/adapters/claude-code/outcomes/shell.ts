/**
 * A small, tolerant shell-command splitter. It is not a shell: it only needs to find the simple
 * commands inside a Bash tool call (`cd app && FOO=1 pnpm test -- --run | tee out.log`) and the
 * files they write to, so the tier classifier and detectors can look at command heads instead of
 * substrings. Quoted text stays inside one argument, so `echo "pnpm test"` is one `echo` command.
 */

export interface SimpleCommand {
  /** Words after quote removal, redirections excluded. */
  argv: string[];
  /** Targets of output redirections (`>`, `>>`, `&>`). */
  writes: string[];
}

const DELIMS = new Set(['\n', ';', '(', ')', '`']);

/** Split a command line into simple commands (on `&&`, `||`, `;`, `|`, `&`, newlines, subshells). */
export function parseShell(input: string): SimpleCommand[] {
  const s = input;
  const out: SimpleCommand[] = [];
  let argv: string[] = [];
  let writes: string[] = [];
  let cur = '';
  let hasTok = false;
  let pending: 'write' | 'read' | 'heredoc' | null = null;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let heredocStrip = false;

  const pushTok = () => {
    if (!hasTok) return;
    if (pending === 'write') writes.push(cur);
    else if (pending === 'heredoc') heredocs.push({ delim: cur, strip: heredocStrip });
    else if (pending !== 'read') argv.push(cur);
    pending = null;
    cur = '';
    hasTok = false;
  };
  const endSeg = () => {
    pushTok();
    pending = null;
    if (argv.length > 0 || writes.length > 0) out.push({ argv, writes });
    argv = [];
    writes = [];
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "'") {
      let j = s.indexOf("'", i + 1);
      if (j < 0) j = s.length;
      cur += s.slice(i + 1, j);
      hasTok = true;
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1] as string)) {
          j++;
          if (s[j] !== '\n') cur += s[j];
          continue;
        }
        cur += s[j];
      }
      hasTok = true;
      i = j;
      continue;
    }
    if (c === '\\') {
      const next = s[i + 1];
      if (next !== undefined && next !== '\n') {
        cur += next;
        hasTok = true;
      }
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushTok();
      continue;
    }
    if (c === '#' && !hasTok) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '\n') pushTok();
    if (c === '\n' && heredocs.length > 0) {
      endSeg();
      i = skipHeredocBodies(s, i + 1, heredocs.splice(0)) - 1;
      continue;
    }
    if (DELIMS.has(c)) {
      // `$(` and `${` start a substitution; treat the `$` as noise.
      if (c === '(' && cur.endsWith('$')) {
        cur = cur.slice(0, -1);
        hasTok = cur.length > 0;
      }
      endSeg();
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '>') {
        pushTok();
        i++;
        if (s[i + 1] === '>') i++;
        pending = 'write';
        continue;
      }
      if (s[i + 1] === '&') i++;
      endSeg();
      continue;
    }
    if (c === '|') {
      if (s[i + 1] === '|') i++;
      endSeg();
      continue;
    }
    if (c === '>') {
      if (hasTok && /^\d+$/.test(cur)) {
        cur = '';
        hasTok = false;
      } else pushTok();
      if (s[i + 1] === '>' || s[i + 1] === '|') i++;
      if (s[i + 1] === '&') {
        // fd duplication like 2>&1: no file target
        i++;
        while (i + 1 < s.length && /[\d-]/.test(s[i + 1] as string)) i++;
        continue;
      }
      pending = 'write';
      continue;
    }
    if (c === '<') {
      pushTok();
      if (s[i + 1] === '<') {
        i++;
        if (s[i + 1] === '<') {
          i++; // here-string
          pending = 'read';
          continue;
        }
        heredocStrip = s[i + 1] === '-';
        if (heredocStrip) i++;
        pending = 'heredoc';
        continue;
      }
      pending = 'read';
      continue;
    }
    cur += c;
    hasTok = true;
  }
  endSeg();
  return out;
}

function skipHeredocBodies(
  s: string,
  start: number,
  docs: { delim: string; strip: boolean }[],
): number {
  let pos = start;
  for (const doc of docs) {
    while (pos < s.length) {
      let end = s.indexOf('\n', pos);
      if (end < 0) end = s.length;
      const line = s.slice(pos, end);
      pos = end + 1;
      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
    }
  }
  return Math.min(pos, s.length);
}

const SIMPLE_WRAPPERS = new Set([
  'sudo',
  'time',
  'nice',
  'nohup',
  'command',
  'exec',
  'caffeinate',
  'stdbuf',
  'npx',
  'bunx',
  'pnpx',
]);
/** `<tool> <sub>` pairs that just run the rest of the line. */
const SUB_WRAPPERS: Record<string, readonly string[]> = {
  pnpm: ['exec', 'dlx'],
  npm: ['exec'],
  yarn: ['dlx', 'exec'],
  bundle: ['exec'],
  poetry: ['run'],
  uv: ['run'],
  pipenv: ['run'],
  hatch: ['run'],
  rye: ['run'],
  pdm: ['run'],
};

export function basename(word: string): string {
  const i = word.lastIndexOf('/');
  return i >= 0 ? word.slice(i + 1) : word;
}

const GROUPING = new Set(['{', '}', '!', 'then', 'do', 'else']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drop env assignments and wrappers (`sudo`, `npx`, `env`, `timeout 60`, `uv run`, `python -m`). */
export function unwrap(argvIn: readonly string[]): string[] {
  let argv = [...argvIn];
  for (let guard = 0; guard < 10; guard++) {
    while (
      argv.length > 0 &&
      (ENV_ASSIGN.test(argv[0] as string) || GROUPING.has(argv[0] as string))
    )
      argv.shift();
    const head = argv[0];
    if (head === undefined) return argv;
    const h = basename(head);
    if (SIMPLE_WRAPPERS.has(h)) {
      argv.shift();
      while (argv.length > 0 && (argv[0] as string).startsWith('-')) argv.shift();
      continue;
    }
    if (h === 'env') {
      argv.shift();
      while (
        argv.length > 0 &&
        ((argv[0] as string).startsWith('-') || ENV_ASSIGN.test(argv[0] as string))
      )
        argv.shift();
      continue;
    }
    if (h === 'timeout') {
      argv.shift();
      while (argv.length > 0 && (argv[0] as string).startsWith('-')) argv.shift();
      argv.shift(); // duration
      continue;
    }
    if (/^python(\d(\.\d+)?)?$/.test(h) && argv[1] === '-m' && argv[2] !== undefined) {
      argv = argv.slice(2);
      continue;
    }
    const subs = SUB_WRAPPERS[h];
    if (subs !== undefined && argv[1] !== undefined && subs.includes(argv[1])) {
      argv = argv.slice(2);
      while (argv.length > 0 && (argv[0] as string).startsWith('-')) argv.shift();
      continue;
    }
    return argv;
  }
  return argv;
}

/** Positional (non-flag) words after the head, skipping the values of the given flags. */
export function positionals(args: readonly string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}
