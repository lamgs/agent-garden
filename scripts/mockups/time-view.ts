/**
 * MOCKUP: the time-based "Almanac" view, rendered as one static HTML page from real (demo) data.
 * Not part of the app. Run:
 *
 *   tsx scripts/mockups/time-view.ts --db <garden.db copy> --api <dir with garden.json,
 *       seasons-<bedId>.json, knowledge-<bedId>.json, live.json> --out docs/mockups/time-view.html
 *
 * Inputs come from the running server's own API (same numbers as the app) plus one SQL pass over
 * runs + outcomes for per-week detail. Colors are the garden's validated palette (core/palette.ts).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BLOOM,
  COST_RAMP,
  INK,
  MODEL_FAMILY_COLORS,
  PAPER,
  SOIL,
  STALE,
  STATUS,
  WATER,
} from '../../packages/core/src/palette';
import type {
  GardenView,
  KnowledgeView,
  LiveSnapshot,
  SeasonsView,
} from '../../packages/core/src/index';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${k}`);
  return process.argv[i + 1]!;
};
const API = arg('--api');
const OUT = arg('--out');
const db = new DatabaseSync(arg('--db'), { readOnly: true });
const json = <T>(f: string): T => JSON.parse(readFileSync(`${API}/${f}`, 'utf8')) as T;

const garden = json<GardenView>('garden.json');
const live = json<LiveSnapshot>('live.json');
const DAY = 86_400_000;
const from = Date.parse(garden.window.from);
const to = Date.parse(garden.window.to);

// ---- layout ------------------------------------------------------------------------------------
const W = 1440;
const X0 = 232; // left gutter (labels)
const NOW_W = 150; // "Now" column
const X1 = W - NOW_W - 28; // right edge of the history plot
const xOf = (t: number) => X0 + ((t - from) / (to - from)) * (X1 - X0);
const WEEKS = Math.ceil((to - from) / (7 * DAY));
const weekStart = (i: number) => Math.max(from, to - (WEEKS - i) * 7 * DAY);
const weekOf = (t: number) => WEEKS - 1 - Math.floor((to - t - 1) / (7 * DAY));

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// ---- data: runs + outcomes ---------------------------------------------------------------------
interface R {
  id: string;
  agent: string;
  agentName: string;
  fam: string;
  loop: string | null;
  t: number;
  label: string;
  shipped: boolean;
  verified: boolean;
}
const rows = db
  .prepare(
    `select r.id, r.agent_id, a.name agent_name, r.family_id, r.loop_id, r.started_at,
            coalesce(m.label, o.label) label, o.signals_json
       from runs r join agents a on a.id = r.agent_id
       left join outcomes o on o.run_id = r.id
       left join manual_labels m on m.run_id = r.id
      where r.started_at >= ? and r.started_at < ?`,
  )
  .all(garden.window.from, garden.window.to) as Record<string, string | null>[];
const runs: R[] = rows.map((r) => {
  const sig = JSON.parse(r.signals_json ?? '[]') as { id: string; fired: boolean | null }[];
  const fired = (id: string) => sig.find((s) => s.id === id)?.fired === true;
  return {
    id: r.id!,
    agent: r.agent_id!,
    agentName: r.agent_name!,
    fam: r.family_id!,
    loop: r.loop_id,
    t: Date.parse(r.started_at!),
    label: r.label ?? 'unknown',
    shipped: fired('shipped'),
    verified: fired('shipped') && fired('tests_passed_after_last_edit'),
  };
});
const loops = db
  .prepare('select id, name, tier, trigger_kind, expected_interval_sec, targets_json from loops')
  .all() as Record<string, string | number | null>[];

const credit = (l: string) =>
  l === 'success' ? 1 : l === 'partial' ? 0.5 : l === 'failure' ? 0 : null;

// Global scales so beds compare honestly.
const weekRunsMax = (() => {
  let m = 1;
  const c = new Map<string, number>();
  for (const r of runs)
    if (!r.loop) {
      const k = `${r.fam}|${r.agent}|${weekOf(r.t)}`;
      c.set(k, (c.get(k) ?? 0) + 1);
      m = Math.max(m, c.get(k)!);
    }
  return m;
})();
const shipWeekMax = (() => {
  let m = 1;
  const c = new Map<string, number>();
  for (const r of runs)
    if (r.shipped) {
      const k = `${r.fam}|${weekOf(r.t)}`;
      c.set(k, (c.get(k) ?? 0) + 1);
      m = Math.max(m, c.get(k)!);
    }
  return m;
})();
const knowledge = new Map(
  garden.beds.map((b) => [b.id, json<KnowledgeView>(`knowledge-${b.id}.json`)]),
);
const tokMax = Math.max(
  1,
  ...[...knowledge.values()].flatMap((k) => [
    k.budget.alwaysTokens,
    ...k.history.map((h) => h.tokens),
  ]),
);

// ---- svg building ------------------------------------------------------------------------------
const out: string[] = [];
const push = (s: string) => out.push(s);
const text = (
  x: number,
  y: number,
  s: string,
  o: {
    size?: number;
    fill?: string;
    anchor?: string;
    weight?: number;
    italic?: boolean;
    family?: string;
  } = {},
) =>
  push(
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${o.size ?? 11}" fill="${o.fill ?? INK.secondary}"` +
      `${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}` +
      `${o.italic ? ' font-style="italic"' : ''} font-family="${o.family ?? 'var(--sans)'}">${esc(s)}</text>`,
  );

/** A weekly plant: stem height = runs that week; bloom = success share (pie), ring only when n<5. */
function plant(
  cx: number,
  base: number,
  n: number,
  succ: number | null,
  known: number,
  tip: string,
) {
  if (n === 0) {
    push(
      `<line x1="${cx - 3}" y1="${base}" x2="${cx + 3}" y2="${base}" stroke="${INK.hairline}" stroke-width="1"/>`,
    );
    return;
  }
  const h = 4 + 16 * Math.sqrt(n / weekRunsMax);
  const top = base - h;
  push(`<g class="hit"><title>${esc(tip)}</title>`);
  push(`<rect x="${cx - 12}" y="${top - 8}" width="24" height="${h + 10}" fill="transparent"/>`);
  push(
    `<path d="M${cx} ${base} C ${cx - 1.5} ${base - h * 0.4}, ${cx + 1.5} ${base - h * 0.7}, ${cx} ${top}" stroke="${COST_RAMP[2]}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  );
  if (h > 10)
    push(
      `<path d="M${cx} ${base - h * 0.45} q -5 -1 -7 -5 q 5 0 7 4" fill="${COST_RAMP[1]}" stroke="none"/>`,
    );
  const r = 6.5;
  if (known < 5 || succ == null) {
    push(
      `<circle cx="${cx}" cy="${top - r + 1}" r="${r - 0.5}" fill="${PAPER}" stroke="${BLOOM.bud}" stroke-width="1.2"/>`,
    );
  } else {
    const cy = top - r + 1;
    push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PAPER}" stroke="${INK.secondary}" stroke-width="0.9"/>`,
    );
    if (succ >= 0.999) push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BLOOM.petal}"/>`);
    else if (succ > 0.001) {
      const a = succ * 2 * Math.PI;
      const ex = cx + r * Math.sin(a);
      const ey = cy - r * Math.cos(a);
      push(
        `<path d="M${cx} ${cy} L${cx} ${cy - r} A${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z" fill="${BLOOM.petal}"/>`,
      );
    }
    push(`<circle cx="${cx}" cy="${cy}" r="1.3" fill="${BLOOM.center}"/>`);
  }
  push('</g>');
}

const ACT_WORD: Record<string, string> = {
  thinking: 'thinking',
  reading: 'reading',
  searching: 'searching',
  editing: 'editing',
  running: 'running a command',
  web: 'on the web',
  mcp: 'calling MCP',
  skill: 'using a skill',
  delegating: 'delegating',
  waiting_permission: 'needs permission',
  waiting_input: 'waiting for you',
  compacting: 'compacting',
  errored: 'error',
  done: 'just finished',
  idle: 'idle',
};

function nowGlyph(x: number, y: number, a: LiveSnapshot['agents'][number]) {
  const waiting = a.activity === 'waiting_permission' || a.activity === 'waiting_input';
  const fill = Math.min(1, a.contextTokens / Math.max(1, a.contextWindow));
  const r = 7;
  push(
    `<g class="hit"><title>${esc(`${a.agentName} · ${a.activity}\n${a.evidence}\ncontext ${Math.round(fill * 100)}% of window`)}</title>`,
  );
  push(
    `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${INK.hairline}" stroke-width="1.6"/>`,
  );
  if (fill > 0) {
    const ang = Math.max(0.05, fill) * 2 * Math.PI;
    const ex = x + r * Math.sin(ang);
    const ey = y - r * Math.cos(ang);
    push(
      `<path d="M${x} ${y - r} A${r} ${r} 0 ${ang > Math.PI ? 1 : 0} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}" fill="none" stroke="${WATER.flow}" stroke-width="2.2" stroke-linecap="round"/>`,
    );
  }
  if (waiting)
    push(
      `<rect x="${x + 11}" y="${y - 7}" width="14" height="14" rx="3" fill="${STATUS.warning}" stroke="${INK.primary}" stroke-width="0.9" stroke-dasharray="${live.source === 'hooks' ? '0' : '2 1.5'}"/>` +
        `<text x="${x + 18}" y="${y + 3.5}" font-size="10" font-weight="700" text-anchor="middle" fill="${INK.primary}" font-family="var(--sans)">${a.activity === 'waiting_permission' ? '!' : '?'}</text>`,
    );
  push('</g>');
  text(x + (waiting ? 30 : 13), y + 3.5, ACT_WORD[a.activity] ?? a.activity, {
    size: 10.5,
    fill: waiting ? INK.primary : INK.secondary,
    weight: waiting ? 600 : undefined,
  });
}

// ---- page header + legend ----------------------------------------------------------------------
let y = 0;
const H_HEAD = 196;
y = H_HEAD;

// Week grid + month labels (drawn per block below; axis on top here).
function axis(yTop: number) {
  for (
    let t = Date.UTC(2026, 6, 1);
    t < to;
    t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)
  ) {
    if (t < from || xOf(t) > X1 - 70) continue;
    const x = xOf(t);
    push(`<line x1="${x}" y1="${yTop + 6}" x2="${x}" y2="${yTop + 12}" stroke="${INK.muted}"/>`);
    text(
      x + 3,
      yTop + 12,
      new Date(t).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }),
      { size: 10.5, fill: INK.muted },
    );
  }
}

// ---- bed blocks --------------------------------------------------------------------------------
const ORDER = [
  'shop-api',
  'legacy-monolith',
  'data-pipeline',
  'infra',
  'web-dashboard',
  'docs-site',
];
const beds = [...garden.beds].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
const ROW = 38;

for (const bed of beds) {
  const seasons = json<SeasonsView>(`seasons-${bed.id}.json`);
  const kv = knowledge.get(bed.id)!;
  const bedRuns = runs.filter((r) => r.fam === bed.id);
  const family =
    (Object.keys(MODEL_FAMILY_COLORS) as (keyof typeof MODEL_FAMILY_COLORS)[]).find((f) =>
      (bed.soil.model ?? '').toLowerCase().includes(f),
    ) ?? 'other';
  const blockTop = y;

  // header
  push(
    `<rect x="24" y="${y + 4}" width="11" height="11" rx="2" fill="${MODEL_FAMILY_COLORS[family]}"/>`,
  );
  push(
    `<text x="42" y="${y + 15}" font-family="var(--serif)"><tspan font-size="17" font-weight="600" fill="${INK.primary}">${esc(bed.name)}</tspan>` +
      `<tspan dx="10" font-size="11.5" font-family="var(--sans)" fill="${INK.secondary}">${esc(`${(bed.soil.model ?? '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')} · ${bed.soil.effort ?? ''}`)}</tspan></text>`,
  );
  y += 30;

  // season boundaries (harness changes) within the window, deduped across agents within an hour
  const bounds: { t: number; title: string; summary: string[]; n: number }[] = [];
  for (const s of [...seasons.seasons].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const t = Date.parse(s.from);
    // A chain's first season is when the agent first ran, not a harness change.
    const chain = seasons.seasons.filter((x) => x.agentId === s.agentId);
    if (chain.indexOf(s) === 0 || t <= from) continue;
    // One harness change reaches each agent at its next run; keep the earliest sighting.
    if (bounds.some((b) => Math.abs(b.t - t) < 3_600_000 || b.title === s.title)) continue;
    bounds.push({ t, title: s.title, summary: s.diffSummary, n: 0 });
  }
  bounds.sort((a, b) => a.t - b.t);
  // Changes a day or two apart read as one event: one rule, one label, numbered as a range.
  const merged: ((typeof bounds)[number] & { n2?: number })[] = [];
  bounds.forEach((b, i) => {
    b.n = i + 2;
    const prev = merged[merged.length - 1];
    if (prev && b.t - prev.t < 2 * DAY) {
      prev.title = `${prev.title}; ${b.title}`;
      prev.summary = [...prev.summary, ...b.summary];
      prev.n2 = b.n;
    } else merged.push({ ...b });
  });
  bounds.splice(0, bounds.length, ...merged);

  // soil band: always-loaded tokens over time (step), shared scale across beds
  if (bounds.length) y += 14;
  const soilTop = y;
  const SOIL_H = 26;
  text(X0 - 12, y + 12, 'Soil: CLAUDE.md in git', { size: 11, anchor: 'end', fill: INK.secondary });
  text(X0 - 12, y + 24, 'always-loaded tokens', { size: 9.5, anchor: 'end', fill: INK.muted });
  push(
    `<rect x="${X0}" y="${y}" width="${X1 - X0}" height="${SOIL_H}" fill="${SOIL.fill}" opacity="0.45"/>`,
  );
  const hist = [...kv.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const valAt = (t: number) => {
    let v = hist[0]?.tokens ?? kv.budget.alwaysTokens;
    for (const h of hist) if (Date.parse(h.at) <= t) v = h.tokens;
    return v;
  };
  const steps = [from, ...hist.map((h) => Date.parse(h.at)).filter((t) => t > from && t < to), to];
  let d = '';
  const hOf = (v: number) => SOIL_H * Math.min(1, v / tokMax);
  steps.forEach((t, i) => {
    const v = valAt(i === steps.length - 1 ? to - 1 : t);
    const xa = xOf(t);
    const xb = xOf(steps[i + 1] ?? to);
    if (i === steps.length - 1) return;
    d += `${i === 0 ? 'M' : 'L'}${xa.toFixed(1)} ${(y + SOIL_H - hOf(v)).toFixed(1)} L${xb.toFixed(1)} ${(y + SOIL_H - hOf(v)).toFixed(1)} `;
  });
  push(
    `<path d="${d} L${X1} ${y + SOIL_H} L${X0} ${y + SOIL_H} Z" fill="${SOIL.strata}" stroke="${SOIL.rim}" stroke-width="1"/>`,
  );
  const v0 = valAt(from);
  const v1 = valAt(to - 1);
  text(X0 + 4, y + SOIL_H - hOf(v0) - 3, `${kTok(v0)}`, { size: 10, fill: INK.secondary });
  text(X1 - 4, y + SOIL_H - hOf(v1) - 3, `${kTok(v1)}`, {
    size: 10,
    fill: INK.secondary,
    anchor: 'end',
  });
  const over = kv.budget.alwaysTokens > kv.budget.budgetTokens;
  text(X1 + 20, y + 11, `all layers now: ${kTok(kv.budget.alwaysTokens)}`, {
    size: 9.5,
    fill: over ? STATUS.critical : INK.muted,
    weight: over ? 600 : undefined,
  });
  if (over)
    text(X1 + 20, y + 23, `over the ${kTok(kv.budget.budgetTokens)} budget`, {
      size: 9.5,
      fill: STATUS.critical,
    });
  y += SOIL_H + 8;

  // plant rows: plantings without loop-triggered runs (loops get irrigation rows)
  const byAgent = new Map<string, R[]>();
  for (const r of bedRuns) if (!r.loop) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]);
  const agents = [...byAgent.entries()].sort(
    (a, b) =>
      Number(b[1][0]!.agentName === 'main') - Number(a[1][0]!.agentName === 'main') ||
      b[1].length - a[1].length,
  );
  const shown = agents.slice(0, 5);
  const rowsTop = y;
  for (const [agentId, rs] of shown) {
    const base = y + ROW - 8;
    const name = rs[0]!.agentName;
    text(X0 - 12, base - 10, name, { size: 12.5, anchor: 'end', fill: INK.primary, weight: 600 });
    const known = rs.filter((r) => credit(r.label) !== null);
    const rate = known.length
      ? known.reduce((s, r) => s + credit(r.label)!, 0) / known.length
      : null;
    text(X0 - 12, base + 2, `${rs.length} runs · ${pct(rate)} (n=${known.length})`, {
      size: 9.5,
      anchor: 'end',
      fill: INK.muted,
    });
    push(
      `<line x1="${X0}" y1="${base}" x2="${X1}" y2="${base}" stroke="${INK.hairline}" stroke-width="0.8"/>`,
    );
    for (let w = 0; w < WEEKS; w++) {
      const a = weekStart(w);
      const b = w === WEEKS - 1 ? to : weekStart(w + 1);
      const wr = rs.filter((r) => r.t >= a && r.t < b);
      const wk = wr.filter((r) => credit(r.label) !== null);
      const s = wk.length ? wk.reduce((x, r) => x + credit(r.label)!, 0) / wk.length : null;
      const cx = (xOf(a) + xOf(b)) / 2;
      plant(
        cx,
        base,
        wr.length,
        s,
        wk.length,
        `${name} · week of ${fmtDay(a)}\n${wr.length} runs · success ${pct(s)} (n=${wk.length}${wk.length < 5 ? ', too few: hollow bud' : ''})`,
      );
    }
    // season delta at each boundary (from the seasons API, same rule as bed compare)
    const series = seasons.series.find((x) => x.agentId === agentId && !x.loop);
    if (series)
      for (let i = 1; i < series.perSeason.length; i++) {
        const st = series.perSeason[i]!;
        const season = seasons.seasons.find((x) => x.harnessVersionId === st.harnessVersionId);
        if (!season || !st.vsPrevious) continue;
        // Too few labeled runs on either side says nothing; leave the boundary unannotated.
        if (st.success.n < 10 || series.perSeason[i - 1]!.success.n < 10) continue;
        const bx = xOf(Date.parse(season.from));
        if (bx <= X0 + 4) continue;
        const prev = series.perSeason[i - 1]!;
        const sep = st.vsPrevious.separated;
        const label = `${pct(prev.success.value)} → ${pct(st.success.value)}`;
        const tw = label.length * 5.6 + (sep ? 16 : 14);
        push(
          `<rect x="${bx + 5}" y="${base - 30}" width="${tw}" height="15" rx="3" fill="${PAPER}" stroke="${sep ? INK.primary : INK.hairline}" stroke-width="${sep ? 1 : 0.8}" ${sep ? '' : 'stroke-dasharray="2 2"'}/>`,
        );
        text(bx + 9, base - 19, `${sep ? '◆' : '≈'} ${label}`, {
          size: 9.5,
          fill: sep ? INK.primary : INK.muted,
          weight: sep ? 600 : undefined,
        });
      }
    // now column
    const liveHere = live.agents.filter((a) => a.bedId === bed.id && a.agentName === name);
    const urgent = liveHere.sort(
      (a, b) => Number(b.activity.startsWith('waiting')) - Number(a.activity.startsWith('waiting')),
    )[0];
    if (urgent) nowGlyph(X1 + 30, base - 12, urgent);
    y += ROW;
  }
  if (agents.length > shown.length) {
    text(X0 - 12, y + 10, `+${agents.length - shown.length} more agents`, {
      size: 9.5,
      anchor: 'end',
      fill: INK.muted,
      italic: true,
    });
    y += 16;
  }

  // irrigation rows: loops
  const bedLoops = loops.filter((l) => {
    const tg = JSON.parse(String(l.targets_json)) as { familyIds: string[] };
    return tg.familyIds.includes(bed.id) || bedRuns.some((r) => r.loop === l.id);
  });
  const seenHook = new Set<string>();
  for (const l of bedLoops) {
    const lr = bedRuns.filter((r) => r.loop === l.id).sort((a, b) => a.t - b.t);
    const name = String(l.name);
    if (!lr.length && l.trigger_kind === 'hook') {
      if (seenHook.has(name)) continue;
      seenHook.add(name);
    }
    const ly = y + 11;
    const shortName = name.length > 30 ? `${name.slice(0, 29)}…` : name;
    text(X0 - 12, ly + 1, shortName, { size: 11, anchor: 'end', fill: INK.primary });
    const cadence =
      l.trigger_kind === 'hook'
        ? 'hook · runs not recorded'
        : l.expected_interval_sec
          ? `${String(l.tier)} loop · every ${Math.round(Number(l.expected_interval_sec) / 3600) >= 24 ? `${Math.round(Number(l.expected_interval_sec) / 86400)} d` : `${Math.round(Number(l.expected_interval_sec) / 3600)} h`}`
          : `${String(l.tier)} loop`;
    text(X0 - 12, ly + 12, cadence, { size: 9, anchor: 'end', fill: INK.muted });
    if (!lr.length) {
      // configured, executions not observed: thin dotted channel, no rate claimed
      push(
        `<line x1="${X0}" y1="${ly}" x2="${X1}" y2="${ly}" stroke="${WATER.flow}" stroke-width="1" stroke-dasharray="1.5 4" opacity="0.8"/>`,
      );
      y += 24;
      continue;
    }
    const first = lr[0]!.t;
    const last = lr[lr.length - 1]!.t;
    push(
      `<line x1="${xOf(Math.max(from, first))}" y1="${ly}" x2="${xOf(last)}" y2="${ly}" stroke="${WATER.bed}" stroke-width="5" stroke-linecap="round"/>`,
    );
    // per-day counts → flooding day
    const perDay = new Map<number, R[]>();
    for (const r of lr) {
      const dd = Math.floor(r.t / DAY);
      perDay.set(dd, [...(perDay.get(dd) ?? []), r]);
    }
    const expected = Number(l.expected_interval_sec ?? 86400);
    const baseline = Math.max(1, 86400 / expected);
    for (const [dd, rs] of perDay) {
      const x = xOf(dd * DAY + DAY / 2);
      if (rs.length >= Math.max(4, 3 * baseline)) {
        push(
          `<ellipse cx="${x}" cy="${ly + 2}" rx="${6 + Math.sqrt(rs.length) * 2}" ry="5" fill="${WATER.flow}" opacity="0.35"/>`,
        );
        push(
          `<g class="hit"><title>${esc(`Flooding: ${rs.length} runs on ${fmtDay(dd * DAY)} vs a baseline of ${baseline.toFixed(1)}/day; ${rs.filter((r) => r.label === 'failure').length} failed`)}</title>`,
        );
        const fl = `⚠ flooding · ${rs.length} runs on ${fmtDay(dd * DAY)}`;
        const right = x + 12 + fl.length * 5.4 > X1;
        text(right ? x - 12 : x + 12, ly - 6, fl, {
          size: 9.5,
          fill: INK.primary,
          weight: 600,
          anchor: right ? 'end' : undefined,
        });
        push(`<rect x="${x - 8}" y="${ly - 8}" width="16" height="16" fill="transparent"/></g>`);
      }
    }
    for (const r of lr) {
      const x = xOf(r.t);
      push(
        `<line x1="${x.toFixed(1)}" y1="${ly - 4}" x2="${x.toFixed(1)}" y2="${ly + 4}" stroke="${r.label === 'failure' ? STATUS.critical : WATER.flow}" stroke-width="1.3"/>`,
      );
    }
    // dry: no run for > 3× the expected interval before the window end
    if (l.expected_interval_sec && to - last > 3 * expected * 1000) {
      push(
        `<line x1="${xOf(last) + 4}" y1="${ly}" x2="${X1}" y2="${ly}" stroke="${STALE.tip}" stroke-width="1.4" stroke-dasharray="6 3 1 3"/>`,
      );
      text(
        xOf(last) + 10,
        ly - 5,
        `dry · last run ${fmtDay(last)} (expected every ${Math.round(expected / 86400)} d)`,
        { size: 9.5, fill: STALE.tip, weight: 600 },
      );
    }
    y += 24;
  }

  // harvest row: shipped runs per week, verified (tests passed after the last edit) vs not
  {
    const base = y + 26;
    const shippedAll = bedRuns.filter((r) => r.shipped);
    const ver = shippedAll.filter((r) => r.verified).length;
    text(X0 - 12, base - 10, 'Shipped', {
      size: 12,
      anchor: 'end',
      fill: INK.primary,
      weight: 600,
    });
    text(
      X0 - 12,
      base + 2,
      `${shippedAll.length} · ${shippedAll.length ? pct(ver / shippedAll.length) : '–'} verified`,
      { size: 9.5, anchor: 'end', fill: INK.muted },
    );
    push(
      `<line x1="${X0}" y1="${base}" x2="${X1}" y2="${base}" stroke="${INK.hairline}" stroke-width="0.8"/>`,
    );
    for (let w = 0; w < WEEKS; w++) {
      const a = weekStart(w);
      const b = w === WEEKS - 1 ? to : weekStart(w + 1);
      const ws = shippedAll.filter((r) => r.t >= a && r.t < b);
      if (!ws.length) continue;
      const v = ws.filter((r) => r.verified).length;
      const u = ws.length - v;
      const cx = (xOf(a) + xOf(b)) / 2;
      const unit = 22 / shipWeekMax;
      const hv = v * unit;
      const hu = u * unit;
      push(
        `<g class="hit"><title>${esc(`Week of ${fmtDay(a)}: ${ws.length} shipped (git commit / push / gh pr create)\n${v} verified: tests passed after the last edit\n${u} unverified: no passing test after the last edit`)}</title>`,
      );
      push(`<rect x="${cx - 12}" y="${base - 26}" width="24" height="28" fill="transparent"/>`);
      if (hv > 0)
        push(
          `<rect x="${cx - 5}" y="${(base - hv).toFixed(1)}" width="10" height="${hv.toFixed(1)}" rx="1.5" fill="${INK.primary}"/>`,
        );
      if (hu > 0)
        push(
          `<rect x="${cx - 4.5}" y="${(base - hv - hu - (hv > 0 ? 1.5 : 0)).toFixed(1)}" width="9" height="${Math.max(1, hu - 0.5).toFixed(1)}" rx="1.5" fill="${PAPER}" stroke="${INK.primary}" stroke-width="1"/>`,
        );
      push('</g>');
    }
    y = base + 14;
  }

  // season rules drawn last over the block (from the soil band to the harvest row)
  let lastLabelEnd = -1e9;
  let lane = 0;
  for (const b of bounds) {
    const x = xOf(b.t);
    lane = x < lastLabelEnd ? lane + 1 : 0;
    push(
      `<line x1="${x}" y1="${soilTop - 4}" x2="${x}" y2="${y - 10}" stroke="${INK.primary}" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>`,
    );
    push(
      `<g class="hit"><title>${esc(`Harness change ${fmtDay(b.t)}: ${b.title}\n${b.summary.join('\n')}`)}</title>`,
    );
    push(`<circle cx="${x}" cy="${soilTop - 10}" r="7" fill="${PAPER}" stroke="${INK.primary}"/>`);
    const nb = b as typeof b & { n2?: number };
    if (nb.n2)
      push(
        `<rect x="${x - 11}" y="${soilTop - 17}" width="22" height="14" rx="7" fill="${PAPER}" stroke="${INK.primary}"/>`,
      );
    text(x, soilTop - 6.5, nb.n2 ? `${b.n}–${nb.n2}` : String(b.n), {
      size: nb.n2 ? 8.5 : 9.5,
      anchor: 'middle',
      fill: INK.primary,
      weight: 700,
    });
    push('</g>');
    const full = `${fmtDay(b.t)} · ${b.title}`;
    const lx = (b as typeof b & { n2?: number }).n2 ? 14 : 11;
    const label = full.length > 58 ? `${full.slice(0, 57)}…` : full;
    const ly = soilTop - 6.5 + lane * 13;
    if (lane)
      push(
        `<rect x="${x + 9}" y="${ly - 10}" width="${label.length * 5.6 + 6}" height="13" fill="${PAPER}" opacity="0.9"/>`,
      );
    text(x + lx, ly, label, {
      size: 10.5,
      fill: INK.primary,
      italic: true,
      family: 'var(--serif)',
    });
    lastLabelEnd = x + 11 + label.length * 5.6;
  }
  void rowsTop;

  // block frame
  push(`<line x1="24" y1="${y + 6}" x2="${W - 24}" y2="${y + 6}" stroke="${INK.hairline}"/>`);
  y += 26;
  void blockTop;
}

// "now" divider
const plotTop = H_HEAD - 24;
push(
  `<line x1="${X1 + 12}" y1="${plotTop}" x2="${X1 + 12}" y2="${y - 20}" stroke="${INK.primary}" stroke-width="1.2"/>`,
);
text(X1 + 18, plotTop + 10, 'Now', {
  size: 13,
  fill: INK.primary,
  weight: 700,
  family: 'var(--serif)',
});
text(X1 + 18, plotTop + 23, 'live layer', { size: 9.5, fill: INK.muted });
axis(plotTop - 2);

const H = y + 10;
const legendItems: [string, string][] = [
  [
    'plant',
    'One plant per week. Height = runs that week (√ scale, same for every row). Bloom fill = success share (partial = ½, unknown excluded); hollow bud when fewer than 5 labeled runs.',
  ],
  [
    'rule',
    'Dashed rule = harness change (a new season): commit subject on top, before → after per agent. ◆ = 95% intervals separate, ≈ = within noise. Correlation, not causation.',
  ],
  [
    'soil',
    'Band = tokens loaded in every session (CLAUDE.md chain, imports, MEMORY.md, listings). Same scale for all beds.',
  ],
  [
    'water',
    'Water line = loop-triggered runs (one tick each, red = failed). Pools = flooding day; broken brown line = dry (no run for 3× the cadence); dotted = configured, runs not recorded.',
  ],
  [
    'ship',
    'Shipped = runs that committed, pushed, or opened a PR. Solid = verified (tests passed after the last edit), outline = unverified.',
  ],
  [
    'now',
    'Now = what each agent is doing at this moment. Ring = context fill; amber tag = waiting on you (dashed when inferred).',
  ],
];

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Agent Garden · Almanac (mockup)</title>
<style>
  :root { --serif: 'Fraunces', Georgia, 'Times New Roman', serif; --sans: 'Source Sans 3', 'Helvetica Neue', Arial, sans-serif; }
  body { margin: 0; background: ${PAPER}; color: ${INK.primary}; font-family: var(--sans); }
  .wrap { width: ${W}px; margin: 0 auto; position: relative; }
  header { position: absolute; left: 24px; right: 24px; top: 18px; }
  h1 { font-family: var(--serif); font-weight: 600; font-size: 30px; margin: 0; }
  .sub { color: ${INK.secondary}; font-style: italic; font-family: var(--serif); margin: 4px 0 10px; font-size: 15px; }
  .mock { display: inline-block; font: 600 10px var(--sans); letter-spacing: .08em; text-transform: uppercase; color: ${INK.secondary}; border: 1px dashed ${INK.muted}; border-radius: 3px; padding: 2px 6px; margin-left: 10px; vertical-align: 6px; }
  .legend { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 22px; font-size: 11.5px; color: ${INK.secondary}; line-height: 1.35; max-width: 1360px; }
  .legend b { color: ${INK.primary}; }
  svg .hit:hover { filter: drop-shadow(0 0 2px rgba(0,0,0,.35)); }
</style></head>
<body><div class="wrap">
<header>
  <h1>Almanac <span class="mock">mockup · demo data</span></h1>
  <p class="sub">What grew, what shipped, and what changed in the soil, ${fmtDay(from)} → ${fmtDay(to)}, with what is happening now at the right edge.</p>
  <div class="legend">${legendItems.map(([k, v]) => `<div><b>${{ plant: 'Plants', rule: 'Seasons', soil: 'Soil', water: 'Irrigation', ship: 'Harvest', now: 'Now' }[k]}.</b> ${esc(v)}</div>`).join('')}</div>
</header>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Almanac mockup">
${out.join('\n')}
</svg></div></body></html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `wrote ${OUT} (${W}×${H}), ${runs.length} runs, weekRunsMax ${weekRunsMax}, shipWeekMax ${shipWeekMax}`,
);
