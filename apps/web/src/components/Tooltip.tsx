import type { Description } from '../describe';

/** Body of a hover tooltip / how-computed popover. Positioned by its parent, imperatively. */
export function DescriptionBody({ d, compact = false }: { d: Description; compact?: boolean }) {
  return (
    <div className="desc">
      <div className="desc-title">{d.title}</div>
      {d.subtitle ? <div className="desc-sub">{d.subtitle}</div> : null}
      <dl className="desc-rows">
        {d.rows.map((r, i) => (
          <div className="desc-row" key={i}>
            <dt>{r.label}</dt>
            <dd>
              {r.value}
              {r.level ? <span className="level-chip">{r.level}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <div className="desc-how">
        <div className="desc-how-title">How computed</div>
        {(compact ? d.how.slice(0, 5) : d.how).map((h, i) => (
          <p key={i}>
            <b>{h.channel}.</b> {h.text}
          </p>
        ))}
      </div>
    </div>
  );
}
