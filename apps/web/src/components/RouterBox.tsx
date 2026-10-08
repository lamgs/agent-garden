/**
 * "Which one do I call?" box in the garden's top bar (`/` focuses it). Shows ranked agents and
 * skills with calibrated confidence, reasons, and a "how computed" breakdown; the garden glows
 * the candidates' plants (encoding router.highlight) while everything else dims.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import type { GardenView, ID, RouterCandidate, RouterResult } from '@garden/core';
import { formatConfidence, loadRoute, ROUTE_QUERY_MAX, type RouteLoad } from '../data/router';
import './router.css';

export interface RouterBoxHandle {
  focus(): void;
}

interface Props {
  days: number;
  view: GardenView | null;
  onResult: (r: RouterResult | null) => void;
  onSelect: (plantId: ID) => void;
}

const REASON_LABEL: Record<RouterCandidate['reasons'][number]['kind'], string> = {
  description_match: 'Description',
  similar_past_task: 'Similar past task',
  outcome_history: 'Outcome history',
};

export const RouterBox = forwardRef<RouterBoxHandle, Props>(function RouterBox(
  { days, view, onResult, onSelect },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState<RouteLoad | null>(null);
  const [busy, setBusy] = useState(false);
  /** Results folded away (e.g. after opening a plant); the garden keeps glowing. */
  const [folded, setFolded] = useState(false);
  const seq = useRef(0);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  const clear = () => {
    seq.current++;
    setState(null);
    setBusy(false);
    onResult(null);
  };

  const ask = async (text: string) => {
    if (!text.trim()) return clear();
    const mine = ++seq.current;
    setBusy(true);
    const r = await loadRoute(text, days);
    if (mine !== seq.current) return;
    setBusy(false);
    setFolded(false);
    setState(r);
    onResult(r.status === 'ok' ? r.result : null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(q);
  };

  const bedName = new Map(view?.beds.map((b) => [b.id, b.name]) ?? []);
  const plantBed = new Map(view?.plants.map((p) => [p.id, p.bedId]) ?? []);
  const result = state?.status === 'ok' ? state.result : null;

  return (
    <section className="router-box" aria-label="Which one do I call?">
      <form role="search" onSubmit={submit}>
        <label htmlFor="router-q" className="router-label">
          Which one do I call?
        </label>
        <input
          id="router-q"
          ref={input}
          type="search"
          value={q}
          maxLength={ROUTE_QUERY_MAX}
          placeholder="Describe the task, e.g. “write tests for the refund flow”"
          autoComplete="off"
          onFocus={() => setFolded(false)}
          onChange={(e) => {
            setQ(e.target.value);
            if (!e.target.value) clear();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setQ('');
              clear();
              input.current?.blur();
            }
          }}
        />
        <kbd className="router-kbd" aria-hidden="true">
          /
        </kbd>
        <button type="submit" disabled={busy || !q.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {state && state.status !== 'ok' ? (
        <div className="router-results" role="status">
          <p className="router-msg">{state.message}</p>
          {state.status === 'missing' && state.examples.length ? (
            <ul className="router-examples">
              {state.examples.map((ex) => (
                <li key={ex}>
                  <button
                    type="button"
                    onClick={() => {
                      setQ(ex);
                      void ask(ex);
                    }}
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {result && !folded ? (
        <div className="router-results" aria-live="polite">
          {result.candidates.length === 0 ? (
            <p className="router-msg">
              Nothing in your garden matches this. No agent or skill shares words or meaning with
              it.
            </p>
          ) : (
            <ol className="router-list">
              {result.candidates.map((c, i) => (
                <CandidateRow
                  key={`${c.kind}:${c.id}`}
                  c={c}
                  rank={i + 1}
                  method={result.method}
                  beds={[
                    ...new Set(c.plantIds.map((p) => bedName.get(plantBed.get(p) ?? '') ?? '')),
                  ].filter(Boolean)}
                  onSelect={
                    c.plantIds[0]
                      ? () => {
                          setFolded(true);
                          onSelect(c.plantIds[0]!);
                        }
                      : undefined
                  }
                />
              ))}
            </ol>
          )}
          <p className="router-foot">
            Glowing plants in the garden are these suggestions; everything else is dimmed.{' '}
            <kbd>Esc</kbd> in the box clears.
          </p>
        </div>
      ) : null}
    </section>
  );
});

function CandidateRow({
  c,
  rank,
  method,
  beds,
  onSelect,
}: {
  c: RouterCandidate;
  rank: number;
  method: RouterResult['method'];
  beds: string[];
  onSelect: (() => void) | undefined;
}) {
  const w = method.weights;
  const rows: [string, string, number, number][] = [
    [
      'Lexical',
      'BM25 over name, description, past task previews (÷ best for this query)',
      c.components.lexical,
      w.lexical,
    ],
    [
      'Embedding',
      `${method.embedding === 'tfidf-lsa' ? 'TF-IDF + LSA' : method.embedding} cosine`,
      c.components.embedding,
      w.embedding,
    ],
    [
      'Outcome',
      'Beta(2,2)-smoothed success, k most similar past runs',
      c.components.outcome,
      w.outcome,
    ],
  ];
  const history = c.reasons.find((r) => r.kind === 'outcome_history');
  return (
    <li className="router-cand" data-candidate={c.name}>
      <div className="router-cand-head">
        <span className="router-rank">{rank}</span>
        <span className="router-name">{c.name}</span>
        <span className={`router-kind router-kind-${c.kind}`}>{c.kind}</span>
        <span
          className="router-conf"
          title="Calibrated confidence that this is the right one to call"
        >
          {formatConfidence(c.confidence)}
        </span>
      </div>
      <div className="router-meter" aria-hidden="true">
        <span style={{ width: `${Math.round(c.confidence * 100)}%` }} />
      </div>
      <p className="router-beds">
        {beds.length ? `Planted in ${beds.join(', ')}` : 'No plant in this window (never run)'}
        {onSelect ? (
          <>
            {' · '}
            <button type="button" className="linkish" onClick={onSelect}>
              open plant
            </button>
          </>
        ) : null}
      </p>
      <ul className="router-reasons">
        {c.reasons.map((r, i) => (
          <li key={i} data-reason={r.kind}>
            <b>{REASON_LABEL[r.kind]}:</b> {r.text}
          </li>
        ))}
      </ul>
      <details className="router-how">
        <summary>How computed</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Value</th>
              <th scope="col">Weight</th>
              <th scope="col">Adds</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, how, v, wt]) => (
              <tr key={name}>
                <th scope="row" title={how}>
                  {name}
                  <small>{how}</small>
                </th>
                <td>{v.toFixed(3)}</td>
                <td>× {wt.toFixed(2)}</td>
                <td>{(v * wt).toFixed(3)}</td>
              </tr>
            ))}
            <tr className="router-sum">
              <th scope="row">Score</th>
              <td colSpan={3}>{c.score.toFixed(3)}</td>
            </tr>
          </tbody>
        </table>
        <p>
          <b>Confidence {formatConfidence(c.confidence)}</b> = σ(a + b·score + c·margin over the
          best other candidate). {method.calibration}
        </p>
        <p>
          <b>Evidence:</b> {history ? history.text : 'no outcome history'} Corpus:{' '}
          {method.corpusSize} past runs with a task statement in this window.
        </p>
      </details>
    </li>
  );
}
