import type { FlowGoal } from '../api/autopilot-flow.js';

/**
 * The one-line "what is happening now" for the widget cockpit, per goal state —
 * so `proposed` reads as queued rather than "Planning…", and a running goal
 * shows its task progress. Pure, so it is a table of test rows.
 */
export function cockpitStatus(state: FlowGoal['state'], done: number, total: number): string {
  switch (state) {
    case 'proposed':
      return 'Queued · waiting to plan';
    case 'planning':
      return 'Planning…';
    case 'plan_review':
      return total > 0
        ? `Plan ready · ${String(total)} step${total === 1 ? '' : 's'} to review`
        : 'Plan ready to review';
    case 'blocked':
      return 'Blocked · needs your answer';
    case 'running':
      return total > 0
        ? `${String(done)} of ${String(total)} task${total === 1 ? '' : 's'} done`
        : 'Running…';
    default:
      return state;
  }
}
