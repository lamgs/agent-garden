import type { SoilChange } from '../compare-format';

const KEY_LABEL: Record<SoilChange['key'], string> = {
  model: 'model',
  instructions: 'CLAUDE.md',
  mcp: 'MCP',
  hooks: 'hooks',
  effort: 'effort',
  permissions: 'permissions',
  tools: 'tools',
  skills: 'skills',
  settings: 'settings',
  other: 'other',
};

/** The harness difference as a list, biggest items first. */
export function SoilDiffList({ items }: { items: SoilChange[] }) {
  if (!items.length) {
    return <p className="muted">Same harness: nothing differs in the soil.</p>;
  }
  return (
    <ol className="soil-changes">
      {items.map((c, i) => (
        <li key={`${c.key}:${i}`} className={`soil-${c.key}`}>
          <span className="soil-key">{KEY_LABEL[c.key]}</span>
          <span className="soil-title">{c.title}</span>
          {c.detail ? <span className="soil-detail">{c.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
