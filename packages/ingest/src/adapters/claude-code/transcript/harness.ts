import type { ObservedHarness } from '../contracts';

const sorted = (s: Set<string>): string[] => [...s].sort();

/** `mcp__<server>__<tool>` → server, else undefined. */
export function mcpServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const end = rest.indexOf('__');
  const server = end === -1 ? rest : rest.slice(0, end);
  return server.length > 0 ? server : undefined;
}

/** Harness state as it evolves through one thread (main or one subagent) of a transcript. */
export class HarnessTracker {
  model?: string;
  effort?: string;
  permissionMode?: string;
  entrypoint?: string;
  cliVersion?: string;
  private tools = new Set<string>();
  private skills = new Set<string>();
  private subagentTypes = new Set<string>();
  private mcpServers = new Set<string>();

  addTools(names: string[] = [], removed: string[] = []): void {
    for (const n of names) this.tools.add(n);
    for (const n of removed) this.tools.delete(n);
  }

  setSkills(names: string[], replace: boolean): void {
    if (replace) this.skills.clear();
    for (const n of names) this.skills.add(n);
  }

  updateSubagentTypes(added: string[] = [], removed: string[] = [], replace = false): void {
    if (replace) this.subagentTypes.clear();
    for (const n of added) this.subagentTypes.add(n);
    for (const n of removed) this.subagentTypes.delete(n);
  }

  updateMcpServers(added: string[] = [], removed: string[] = []): void {
    for (const n of added) this.mcpServers.add(n);
    for (const n of removed) this.mcpServers.delete(n);
  }

  snapshot(): ObservedHarness {
    const servers = new Set(this.mcpServers);
    for (const t of this.tools) {
      const s = mcpServerOf(t);
      if (s) servers.add(s);
    }
    const out: ObservedHarness = {
      tools: sorted(this.tools),
      skills: sorted(this.skills),
      subagentTypes: sorted(this.subagentTypes),
      mcpServers: sorted(servers),
    };
    if (this.model) out.model = this.model;
    if (this.effort) out.effort = this.effort;
    if (this.permissionMode) out.permissionMode = this.permissionMode;
    if (this.entrypoint) out.entrypoint = this.entrypoint;
    if (this.cliVersion) out.cliVersion = this.cliVersion;
    return out;
  }
}
