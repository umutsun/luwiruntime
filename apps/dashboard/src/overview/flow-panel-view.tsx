import { StatusChip } from '../components/status-chip.js';
import type { FlowPanel } from './model.js';

/**
 * One project's autopilot goal/task flow (ADR 0035), rendered read-only. Shared
 * by the overview drill-down and the LuwiBot widget cockpit so both read the
 * same `autopilotFlowPanel` model and stay visually identical. Loading,
 * unavailable and empty are shown as one line each; a ready panel lists goals
 * in plan order with state and verdict chips.
 */
export function FlowPanelView({ panel }: { panel: FlowPanel }) {
  return (
    <div className="drill__flow">
      <p className="drill__section-label">Autopilot flow</p>
      {panel.status === 'loading' ? (
        <p className="drill__empty">Reading goals…</p>
      ) : panel.status === 'unavailable' ? (
        <p className="drill__empty">Flow unavailable</p>
      ) : panel.status === 'empty' ? (
        <p className="drill__empty">No goals in flight</p>
      ) : (
        panel.goals.map((goal) => (
          <div key={goal.id} className="drill__flow-goal">
            <div className="drill__flow-goal-head">
              <span className="drill__flow-goal-title" title={goal.title}>
                {goal.title}
              </span>
              <StatusChip tone={goal.state.tone}>{goal.state.label}</StatusChip>
            </div>
            {goal.tasks.length === 0 ? (
              <p className="drill__empty">Planning…</p>
            ) : (
              goal.tasks.map((task) => (
                <div key={task.id} className="drill__flow-task">
                  <span className="drill__flow-task-label">{task.label}</span>
                  <span className="drill__flow-task-chips">
                    <StatusChip tone={task.state.tone}>{task.state.label}</StatusChip>
                    {task.verdict === undefined ? null : (
                      <StatusChip tone={task.verdict.tone}>{task.verdict.label}</StatusChip>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        ))
      )}
      {panel.more > 0 ? <p className="drill__empty">+{String(panel.more)} more goal(s)</p> : null}
    </div>
  );
}
