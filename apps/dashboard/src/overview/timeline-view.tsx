import { useState } from 'react';

import {
  emptyProjectsLabel,
  layoutTimeline,
  NOW_FRACTION,
  subagentCount,
  TIMELINE_WINDOWS,
  type Focus,
  type Overview,
  type TimelineWindow,
} from './model.js';

/**
 * The Timeline: one lane per project, one bar per session over a window that
 * ends at NOW. Session start and heartbeat times are observed, so this is the
 * one lens with a real time axis — which is why the window control lives here
 * and not in the header.
 *
 * At the coarse windows a terminal session can be narrower than its own label;
 * the model folds such neighbours into one cluster (`CC ×5`), and the bar's
 * container query drops the task, then the duration, then the initials as the
 * bar narrows, so nothing is ever clipped mid-word.
 */
const LANE_PAD = 8;
const ROW_HEIGHT = 34;
const BAR_HEIGHT = 28;
const pct = (fraction: number): string => `${(fraction * 100).toFixed(3)}%`;

export function TimelineView({
  overview,
  focus,
  onFocus,
}: {
  overview: Overview;
  focus: Focus;
  onFocus: (focus: Focus) => void;
}) {
  const [minutes, setMinutes] = useState<TimelineWindow>(90);
  const layout = layoutTimeline(overview, minutes, focus);
  const histMax = layout.hist.reduce((high, value) => Math.max(high, value), 0);
  const empty =
    overview.projectsState === 'unavailable'
      ? 'Projects unavailable'
      : layout.lanes.length === 0
        ? emptyProjectsLabel(overview)
        : undefined;

  return (
    <div className="timeline">
      <div className="timeline__hist">
        <div className="timeline__hist-head">
          <span>Events · last {layout.windowLabel}</span>
          <span>
            {overview.activityState === 'unavailable'
              ? 'activity unavailable'
              : `${layout.rateLabel} / min · ${String(layout.total)} retained`}
          </span>
          <div className="segmented segmented--mono" role="group" aria-label="Timeline window">
            {TIMELINE_WINDOWS.map((option) => (
              <button
                key={option.minutes}
                type="button"
                className="segmented__option"
                aria-pressed={minutes === option.minutes}
                onClick={() => setMinutes(option.minutes)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="timeline__hist-bars" aria-hidden="true">
          {layout.hist.map((value, index) => (
            <span
              key={index}
              className="timeline__hist-bar"
              style={{
                height: `${String(histMax === 0 || value === 0 ? 0 : Math.max(2, Math.round((value / histMax) * 100)))}%`,
                opacity: index >= layout.hist.length - 3 ? 1 : 0.35,
                animationDelay: `${String(0.5 + index * 0.02)}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="timeline__axis" aria-hidden="true">
        <span className="timeline__axis-head">Project · sessions</span>
        <div className="timeline__axis-track">
          {layout.axis.map((tick, index) => (
            <span
              key={tick.label + String(index)}
              className="timeline__tick"
              style={{ left: pct(tick.x) }}
            >
              {tick.label}
            </span>
          ))}
          <span className="timeline__now-tag" style={{ left: pct(NOW_FRACTION) }}>
            NOW
          </span>
        </div>
      </div>

      <div className="timeline__lanes">
        {empty === undefined ? null : <p className="timeline__empty">{empty}</p>}
        {layout.lanes.map((lane, laneIndex) => {
          const height = LANE_PAD * 2 + lane.rows * ROW_HEIGHT;
          return (
            <div
              key={lane.project.id}
              className={`lane${lane.dim ? ' lane--dim' : ''}`}
              style={{ animationDelay: `${String(0.25 + laneIndex * 0.07)}s` }}
            >
              <button
                type="button"
                className={`lane__head${lane.selected ? ' lane__head--on' : ''}`}
                style={{ minHeight: `${String(height)}px` }}
                aria-pressed={lane.selected}
                aria-label={`Focus project ${lane.project.name}`}
                onClick={() =>
                  onFocus(
                    lane.selected && focus.kind === 'project'
                      ? { kind: 'runtime' }
                      : { kind: 'project', id: lane.project.id },
                  )
                }
              >
                <span className="lane__init">{lane.project.initials}</span>
                <span className="lane__text">
                  <span className="lane__name">{lane.project.name}</span>
                  <span className="lane__sub">{lane.project.badge.label}</span>
                </span>
              </button>
              <div className="lane__track" style={{ minHeight: `${String(height)}px` }}>
                {lane.items.map((item, itemIndex) => {
                  const placement = {
                    left: pct(item.x0),
                    width: pct(item.x1 - item.x0),
                    top: `${String(LANE_PAD + item.row * ROW_HEIGHT)}px`,
                    height: `${String(BAR_HEIGHT)}px`,
                    animationDelay: `${String(0.4 + laneIndex * 0.08 + itemIndex * 0.05)}s`,
                  };
                  const state = `${item.selected ? ' bar--selected' : ''}${item.dim ? ' bar--dim' : ''}`;
                  return item.kind === 'bar' ? (
                    <button
                      key={item.session.id}
                      type="button"
                      className={`bar bar--${item.session.tone}${state}`}
                      style={placement}
                      title={`${item.session.agentName} · ${item.session.statusLabel} · ${item.duration}${
                        item.session.subagents.length > 0
                          ? ` · ${subagentCount(item.session.subagents.length)} running`
                          : ''
                      }`}
                      aria-pressed={item.selected}
                      aria-label={`Focus session ${item.session.id}`}
                      onClick={() => onFocus({ kind: 'session', id: item.session.id })}
                    >
                      <span className="bar__init">{item.session.initials}</span>
                      <span className="bar__task">
                        {item.session.taskSummary ?? item.session.statusLabel}
                        {item.session.subagents.length > 0
                          ? ` · ${subagentCount(item.session.subagents.length)}`
                          : ''}
                      </span>
                      <span className="bar__dur">{item.duration}</span>
                      {item.threads.map((thread, threadIndex) => (
                        <span
                          key={thread.key}
                          className="bar__thread"
                          title={thread.title}
                          style={{
                            // Track fractions, re-based on the bar; the bar clips what falls outside.
                            left: pct((thread.x0 - item.x0) / (item.x1 - item.x0)),
                            width: pct((thread.x1 - thread.x0) / (item.x1 - item.x0)),
                            // A 2 px pitch: the model caps a bar at three, all under its label.
                            bottom: `${String(threadIndex * 2)}px`,
                          }}
                        />
                      ))}
                    </button>
                  ) : (
                    <button
                      key={item.key}
                      type="button"
                      className={`bar bar--cluster bar--done${state}`}
                      style={placement}
                      title={item.title}
                      aria-label={`Focus project ${lane.project.name}: ${item.title}`}
                      onClick={() => onFocus({ kind: 'project', id: lane.project.id })}
                    >
                      <span className="bar__count">{item.label}</span>
                    </button>
                  );
                })}
                {lane.marks.map((mark) => (
                  <span
                    key={mark.key}
                    className={`mark mark--${mark.kind}`}
                    title={mark.title}
                    style={{
                      left: pct(mark.x),
                      top: `${String(LANE_PAD + mark.row * ROW_HEIGHT + BAR_HEIGHT + 3)}px`,
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <div
          className="timeline__now"
          style={{ left: `calc(200px + (100% - 200px) * ${String(NOW_FRACTION)})` }}
          aria-hidden="true"
        >
          <span className="timeline__now-head" />
        </div>
      </div>
    </div>
  );
}
