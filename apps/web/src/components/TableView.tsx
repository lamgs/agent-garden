import {
  bedStrata,
  bedTexture,
  beeCount,
  irrigationFlow,
  plantBloom,
  plantDroop,
  plantFade,
  plantHeight,
  plantHue,
  type GardenView,
  type ID,
} from '@garden/core';
import { plantLabel } from '../describe';
import {
  formatBytes,
  formatCostPerRun,
  formatInt,
  formatLastRun,
  formatRate,
  formatShare,
  formatTotalCost,
  shortModel,
} from '../format';
import { agentOrder } from '../garden/layout';

/** Accessible table equivalent of the garden: the same numbers, no canvas. */
export function TableView({
  view,
  onSelect,
}: {
  view: GardenView;
  onSelect: (plantId: ID) => void;
}) {
  const bedName = new Map(view.beds.map((b) => [b.id, b.name]));
  const order = new Map(agentOrder(view.plants).map((a) => [a.agentId, a.slot]));
  const plants = [...view.plants].sort(
    (a, b) =>
      (bedName.get(a.bedId) ?? '').localeCompare(bedName.get(b.bedId) ?? '') ||
      (order.get(a.agentId) ?? 0) - (order.get(b.agentId) ?? 0),
  );
  return (
    <div className="table-view" role="region" aria-label="Garden as tables">
      <h2>Plants</h2>
      <p className="table-note">
        One row per planting (agent in a bed). Success counts runs with a known label; unknown runs
        are excluded and listed. Costs marked “estimated” include runs with stream-start-only output
        tokens.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Bed</th>
              <th scope="col">Agent</th>
              <th scope="col">Runs (height)</th>
              <th scope="col">Success (bloom)</th>
              <th scope="col">Failure share, 14 d (droop)</th>
              <th scope="col">Last run (fade)</th>
              <th scope="col">Cost per run (foliage)</th>
              <th scope="col">Total cost</th>
              <th scope="col">Skills</th>
            </tr>
          </thead>
          <tbody>
            {plants.map((p) => (
              <tr key={p.id}>
                <td>{bedName.get(p.bedId)}</td>
                <th scope="row">
                  <button type="button" className="link-btn" onClick={() => onSelect(p.id)}>
                    {p.name}
                  </button>
                  <span className="muted">
                    {' '}
                    {p.agentKind === 'main' ? 'main thread' : 'subagent'}
                  </span>
                </th>
                <td>
                  {formatInt(p.runs)}{' '}
                  <span className="level-chip">{plantHeight.levels[plantHeight.level(p)]}</span>
                </td>
                <td>
                  {formatRate(p.success)}{' '}
                  <span className="level-chip">{plantBloom.levels[plantBloom.level(p)]}</span>
                </td>
                <td>
                  {formatShare(p.recentFailureShare)}{' '}
                  <span className="level-chip">{plantDroop.levels[plantDroop.level(p)]}</span>
                </td>
                <td>
                  {formatLastRun(p)}{' '}
                  <span className="level-chip">{plantFade.levels[plantFade.level(p)]}</span>
                </td>
                <td>
                  {formatCostPerRun(p)}{' '}
                  <span className="level-chip">{plantHue.levels[plantHue.level(p)]}</span>
                </td>
                <td>{formatTotalCost(p)}</td>
                <td>
                  {view.skills
                    .filter((s) => s.plantId === p.id)
                    .map((s) => `${s.name} (${s.invocations}×)`)
                    .join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Beds (harnesses)</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Bed</th>
              <th scope="col">Model (edging)</th>
              <th scope="col">Effort</th>
              <th scope="col">Permission mode</th>
              <th scope="col">Tools + MCP (texture)</th>
              <th scope="col">Instructions (strata)</th>
              <th scope="col">Hooks</th>
              <th scope="col">Seasons</th>
              <th scope="col">Agents</th>
            </tr>
          </thead>
          <tbody>
            {view.beds.map((b) => (
              <tr key={b.id}>
                <th scope="row">{b.name}</th>
                <td>
                  {shortModel(b.soil.model)}{' '}
                  <span className="muted">({b.soil.model ?? 'unknown'})</span>
                </td>
                <td>{b.soil.effort ?? 'default'}</td>
                <td>{b.soil.permissionMode ?? '—'}</td>
                <td>
                  {b.soil.toolCount} + {b.soil.mcpCount}{' '}
                  <span className="level-chip">{bedTexture.levels[bedTexture.level(b)]}</span>
                </td>
                <td>
                  {formatBytes(b.soil.instructionBytes)}{' '}
                  <span className="level-chip">{bedStrata.levels[bedStrata.level(b)]}</span>
                </td>
                <td>{b.soil.hookCount}</td>
                <td>{b.seasonCount}</td>
                <td>{b.plantIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Loops (irrigation)</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Loop</th>
              <th scope="col">Tier</th>
              <th scope="col">State</th>
              <th scope="col">Runs per day (flow)</th>
              <th scope="col">Waters</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {view.loops.map((l) => (
              <tr key={l.loopId}>
                <th scope="row">{l.name}</th>
                <td>{l.tier.replace('_', ' ')}</td>
                <td>
                  <span className={`state state-${l.state}`}>{l.state}</span>
                </td>
                <td>
                  {l.observed === false ? 'not recorded' : `${l.runsPerDay.toFixed(2)}/day`}{' '}
                  <span className="level-chip">
                    {irrigationFlow.levels[irrigationFlow.level(l)]}
                  </span>
                </td>
                <td>
                  {[...new Set(l.targetPlantIds)].map((id) => plantLabel(view, id)).join(', ')}
                </td>
                <td>{l.evidence.join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Subagent handoffs (bees)</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Calls</th>
            </tr>
          </thead>
          <tbody>
            {view.bees.map((b) => (
              <tr key={`${b.fromPlantId}>${b.toPlantId}`}>
                <td>{plantLabel(view, b.fromPlantId)}</td>
                <td>{plantLabel(view, b.toPlantId)}</td>
                <td>
                  {formatInt(b.calls)}{' '}
                  <span className="level-chip">{beeCount.levels[beeCount.level(b)]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Weeds</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Subject</th>
              <th scope="col">Bed</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {view.weeds.map((w) => (
              <tr key={w.id}>
                <th scope="row">{w.kind}</th>
                <td>{w.subject.type.replace('_', ' ')}</td>
                <td>{w.bedId ? bedName.get(w.bedId) : 'compost corner'}</td>
                <td>{w.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Playbook gates</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Playbook</th>
              <th scope="col">Step</th>
              <th scope="col">Where</th>
              <th scope="col">Gate</th>
              <th scope="col">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {view.playbooks.flatMap((pb) =>
              pb.steps.map((s, i) => (
                <tr key={`${pb.id}:${i}`}>
                  <th scope="row">{pb.name}</th>
                  <td>
                    {i + 1}. {s.stepId}
                  </td>
                  <td>
                    {s.plantId ? plantLabel(view, s.plantId) : s.bedId ? bedName.get(s.bedId) : '—'}
                  </td>
                  <td>
                    <span className={`state gate-${s.gate}`}>{s.gate}</span>
                  </td>
                  <td>{s.evidence}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
