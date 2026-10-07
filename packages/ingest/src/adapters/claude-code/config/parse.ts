/**
 * Pure parsers for Claude Code config files. None of them throw; problems go to `warnings`.
 * Warnings never quote file content (JSON/YAML error messages can echo snippets, so they are
 * replaced by generic text).
 */
import { parseDocument } from 'yaml';
import { contentHash } from '../../../ids';
import type {
  AgentDefinition,
  ConfigScope,
  HookConfig,
  McpServerConfig,
  SkillDefinition,
} from '../contracts';

export type Rec = Record<string, unknown>;

export const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** JSON.parse that reports failure as a warning without echoing content. */
export function parseJson(text: string, path: string, warnings: string[]): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    warnings.push(`invalid JSON in ${path}`);
    return undefined;
  }
}

export function parseJsonObject(text: string, path: string, warnings: string[]): Rec | undefined {
  const v = parseJson(text, path, warnings);
  if (v === undefined) return undefined;
  if (!isRecord(v)) {
    warnings.push(`expected a JSON object in ${path}`);
    return undefined;
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Frontmatter (agents, skills)
// ---------------------------------------------------------------------------------------------

/** YAML frontmatter between leading `---` lines. Returns undefined when the file has none. */
export function parseFrontmatter(text: string, path: string, warnings: string[]): Rec | undefined {
  const t = text.replace(/^\uFEFF/, '');
  const open = /^---[ \t]*\r?\n/.exec(t);
  if (!open) return undefined;
  const rest = t.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) {
    warnings.push(`unterminated frontmatter in ${path}`);
    return undefined;
  }
  const yamlText = rest.slice(0, close.index);
  try {
    const doc = parseDocument(yamlText, { uniqueKeys: false });
    if (doc.errors.length > 0) {
      warnings.push(`invalid YAML frontmatter in ${path}`);
      return undefined;
    }
    const v: unknown = doc.toJS();
    if (v === null || v === undefined) return {};
    if (!isRecord(v)) {
      warnings.push(`frontmatter is not a mapping in ${path}`);
      return undefined;
    }
    return v;
  } catch {
    warnings.push(`invalid YAML frontmatter in ${path}`);
    return undefined;
  }
}

function toolsList(v: unknown): string[] | undefined {
  const raw = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : undefined;
  if (!raw) return undefined;
  return raw
    .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);
}

const AGENT_KEYS = new Set(['name', 'description', 'tools', 'model']);

export function parseAgent(
  content: Buffer,
  fileName: string,
  path: string,
  scope: AgentDefinition['scope'],
  warnings: string[],
): AgentDefinition {
  const fm = parseFrontmatter(content.toString('utf8'), path, warnings) ?? {};
  const name = str(fm.name)?.trim() || fileName.replace(/\.md$/i, '');
  const agent: AgentDefinition = {
    name,
    scope,
    path,
    contentHash: contentHash(content),
    extraKeys: Object.keys(fm)
      .filter((k) => !AGENT_KEYS.has(k))
      .sort(),
  };
  const description = str(fm.description);
  if (description !== undefined) agent.description = description;
  const tools = toolsList(fm.tools);
  if (tools !== undefined) agent.tools = tools;
  const model = str(fm.model);
  if (model !== undefined) agent.model = model;
  return agent;
}

export function parseSkill(
  content: Buffer,
  dirName: string,
  path: string,
  scope: SkillDefinition['scope'],
  warnings: string[],
  plugin?: string,
): SkillDefinition {
  const fm = parseFrontmatter(content.toString('utf8'), path, warnings) ?? {};
  const skill: SkillDefinition = {
    name: str(fm.name)?.trim() || dirName,
    dirName,
    scope,
    path,
    contentHash: contentHash(content),
  };
  const description = str(fm.description);
  if (description !== undefined) skill.description = description;
  if (plugin !== undefined) skill.plugin = plugin;
  return skill;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/**
 * Hooks: `{ "<Event>": [ { matcher?, hooks: [ { type, command?, prompt?, timeout? } ] } ] }`.
 * Also tolerates entries that are handler objects directly (no inner `hooks` wrapper).
 */
export function parseHooks(
  hooks: unknown,
  sourcePath: string,
  scope: ConfigScope,
  warnings: string[],
): HookConfig[] {
  if (hooks === undefined) return [];
  if (!isRecord(hooks)) {
    warnings.push(`hooks is not an object in ${sourcePath}`);
    return [];
  }
  const out: HookConfig[] = [];
  const push = (event: string, matcher: string | undefined, h: Rec) => {
    const text = str(h.command) ?? str(h.prompt) ?? '';
    const hook: HookConfig = {
      event,
      type: str(h.type) ?? (str(h.command) !== undefined ? 'command' : 'unknown'),
      commandHash: contentHash(text),
      sourcePath,
      scope,
    };
    if (matcher !== undefined) hook.matcher = matcher;
    out.push(hook);
  };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      warnings.push(`hooks.${event} is not an array in ${sourcePath}`);
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        warnings.push(`malformed hook entry under ${event} in ${sourcePath}`);
        continue;
      }
      const matcher = str(entry.matcher);
      if (Array.isArray(entry.hooks)) {
        for (const h of entry.hooks) {
          if (isRecord(h)) push(event, matcher, h);
          else warnings.push(`malformed hook handler under ${event} in ${sourcePath}`);
        }
      } else if ('type' in entry || 'command' in entry || 'prompt' in entry) {
        push(event, matcher, entry);
      } else {
        warnings.push(`hook entry without handlers under ${event} in ${sourcePath}`);
      }
    }
  }
  return out;
}

export interface SettingsFacts {
  allow: string[];
  deny: string[];
  defaultMode?: string;
  model?: string;
}

export function settingsFacts(s: Rec): SettingsFacts {
  const perms = isRecord(s.permissions) ? s.permissions : {};
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const facts: SettingsFacts = { allow: strings(perms.allow), deny: strings(perms.deny) };
  const mode = str(perms.defaultMode);
  if (mode !== undefined) facts.defaultMode = mode;
  const model = str(s.model);
  if (model !== undefined) facts.model = model;
  return facts;
}

/** Config maps whose values are always dropped (key names kept). */
const SECRET_MAPS = new Set(['env', 'headers']);
/** Settings keys holding shell commands that print credentials. */
const CREDENTIAL_COMMAND =
  /^(apiKeyHelper|awsAuthRefresh|awsCredentialExport|gcpAuthRefresh)$|Helper$/;

/** Copy of settings with env/headers values nulled and credential-helper commands omitted. */
export function sanitizeSettings(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeSettings);
  if (!isRecord(v)) return v;
  const out: Rec = {};
  for (const [k, val] of Object.entries(v)) {
    if (SECRET_MAPS.has(k) && isRecord(val)) {
      out[k] = Object.fromEntries(Object.keys(val).map((name) => [name, null]));
    } else if (CREDENTIAL_COMMAND.test(k) && typeof val === 'string') {
      out[k] = '<omitted>';
    } else {
      out[k] = sanitizeSettings(val);
    }
  }
  return out;
}

/** Deep merge for objects; for anything else the later (higher-precedence) value wins. */
export function deepMerge(a: unknown, b: unknown): unknown {
  if (!isRecord(a) || !isRecord(b)) return b;
  const out: Rec = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : isRecord(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, norm(x[k])]),
          )
        : x;
  return JSON.stringify(norm(v));
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

/** Names and transports only from an `mcpServers` map. Every other field is ignored. */
export function mcpServerNames(
  servers: unknown,
  scope: ConfigScope,
  sourcePath: string,
  warnings: string[],
): McpServerConfig[] {
  if (servers === undefined) return [];
  if (!isRecord(servers)) {
    warnings.push(`mcpServers is not an object in ${sourcePath}`);
    return [];
  }
  return Object.entries(servers).map(([name, def]) => {
    const d = isRecord(def) ? def : {};
    const transport = str(d.type) ?? (str(d.url) !== undefined ? 'http' : 'stdio');
    return { name, scope, transport, sourcePath };
  });
}
