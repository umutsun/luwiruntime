import type { FlowGoal } from '../api/autopilot-flow.js';

/*
 * The agentic pipeline a goal moves through, expressed so the operator can see
 * at a glance WHERE in the loop they are and WHERE they are pulled in. `you` is a
 * human touchpoint — a stage LuwiBot hands to the operator — as opposed to the
 * `luwibot` (planning) and `agents` (build/verify) stages that run on their own.
 * Answer and Stop are ever-present overrides, not stages.
 *
 * Pure, so it is a table of test rows rather than logic buried in the widget.
 */

export type FlowActor = 'luwibot' | 'agents' | 'you';
export type StageStatus = 'done' | 'active' | 'upcoming';
export type AgenticStage = {
  key: 'plan' | 'review' | 'build' | 'verify' | 'done';
  label: string;
  actor: FlowActor;
  status: StageStatus;
};

const ORDER: readonly { key: AgenticStage['key']; label: string; actor: FlowActor }[] = [
  { key: 'plan', label: 'Plan', actor: 'luwibot' },
  { key: 'review', label: 'Review', actor: 'you' },
  { key: 'build', label: 'Build', actor: 'agents' },
  { key: 'verify', label: 'Verify', actor: 'agents' },
  { key: 'done', label: 'Done', actor: 'luwibot' },
];

// The index of the stage a goal currently sits at. `blocked` is an escalation
// that can strike before a plan exists (no tasks → the review boundary) or mid
// run (tasks exist → build); either way the Answer control below carries it.
function activeIndex(state: FlowGoal['state'], done: number, total: number): number {
  switch (state) {
    case 'proposed':
    case 'planning':
      return 0;
    case 'plan_review':
      return 1;
    case 'running':
      return total > 0 && done >= total ? 3 : 2;
    case 'blocked':
      return total > 0 ? 2 : 1;
    default:
      return 0;
  }
}

/** The pipeline for a goal, each stage marked done/active/upcoming. */
export function agenticStages(
  state: FlowGoal['state'],
  done: number,
  total: number,
): AgenticStage[] {
  const active = activeIndex(state, done, total);
  return ORDER.map((stage, index) => ({
    ...stage,
    status: index < active ? 'done' : index === active ? 'active' : 'upcoming',
  }));
}

/** The one-line "where you come in", and whether it is the operator's turn now. */
export function involvement(state: FlowGoal['state']): { you: boolean; text: string } {
  switch (state) {
    case 'plan_review':
      return { you: true, text: 'Your turn — approve or reject the plan.' };
    case 'blocked':
      return { you: true, text: 'Your turn — answer the question or stop.' };
    case 'proposed':
    case 'planning':
      return {
        you: false,
        text: "LuwiBot is planning — you're pulled in only if a plan needs approval.",
      };
    case 'running':
      return {
        you: false,
        text: "Agents are working — you're pulled in if it blocks or hits a protected path.",
      };
    default:
      return { you: false, text: '' };
  }
}
