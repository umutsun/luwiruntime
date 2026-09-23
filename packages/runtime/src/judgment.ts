import {
  ORCHESTRATOR_CONTEXT_MAX_BYTES,
  judgmentDecisionSchema,
  type AutopilotPolicy,
  type Goal,
  type GoalRetrospective,
  type JudgmentDecision,
  type JudgmentKind,
  type PlannedTask,
  type SessionView,
  type Task,
  type WorkLease,
} from '@luwi/protocol';

/**
 * Judgments (ADR 0035): the bounded questions the orchestrator asks its brain.
 *
 * LUWI assembles the context and caps it, frames the question with fixed and
 * visible text, and validates the answer against the protocol schema. An
 * answer that fails is sent back once with the exact refusals; a second
 * failure escalates. The brain never receives a tool, only a question.
 */

const TEXT_CAP = 4000;
const ANSWER_CAP = 2000;

function clip(value: string | undefined, max = TEXT_CAP): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max
    ? value
    : `${value.slice(0, max)}… [${String(value.length - max)} more chars]`;
}

export type JudgmentContextInput = {
  kind: JudgmentKind;
  goal: Goal;
  tasks: readonly Task[];
  policy: AutopilotPolicy;
  workers: readonly string[];
  /**
   * Each worker's specialty/lane (the binding's free-text `role`) and its flow
   * roles (ADR 0036), so the plan routes each task to the worker it fits instead
   * of defaulting every task to the first listed worker. Absent for a worker
   * with no declared role — the brain then falls back to presence alone.
   */
  workerRoles?:
    Readonly<Record<string, { role?: string; flowRoles?: readonly string[] }>> | undefined;
  sessions: readonly SessionView[];
  retrospectives: readonly GoalRetrospective[];
  leases: readonly Pick<WorkLease, 'path' | 'agentId' | 'sessionId'>[];
  git?: { branch?: string; headSha?: string } | undefined;
  /** The task under review, with its reviewer's answer when one exists. */
  reviewTask?: Task | undefined;
  reviewAnswer?: { status?: string; answer?: string } | undefined;
  /** Validation refusals from a previous answer, for the one repair round. */
  repairErrors?: readonly string[] | undefined;
  nowIso: string;
  /**
   * The largest context the brain can take, in UTF-8 bytes of its JSON. A
   * native brain receives the prompt on its command line, which Windows caps at
   * 32 767 characters; past that the process never starts. Defaults to
   * {@link ORCHESTRATOR_CONTEXT_MAX_BYTES}.
   */
  maxBytes?: number | undefined;
};

function taskSummary(task: Task) {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    kind: task.kind,
    agentId: task.agentId,
    paths: task.paths,
    dependsOn: task.dependsOn,
    ...(task.reworkOf === undefined ? {} : { reworkOf: task.reworkOf }),
    ...(task.outcome === undefined
      ? {}
      : {
          outcome: {
            messageState: task.outcome.messageState,
            status: task.outcome.status,
            answer: clip(task.outcome.answer, ANSWER_CAP),
            evidenceTypes: task.outcome.evidenceTypes,
          },
        }),
    ...(task.verification === undefined
      ? {}
      : {
          verification: {
            checks: task.verification.checks,
            verdict: task.verification.verdict,
            feedback: clip(task.verification.feedback, 1000),
          },
        }),
  };
}

/** Bounded, inspectable, JSON-able. Shrinks the optional parts first when over the cap. */
export function assembleJudgmentContext(input: JudgmentContextInput): Record<string, unknown> {
  const workerPresence = Object.fromEntries(
    input.workers.map((agentId) => [
      agentId,
      input.sessions.some(
        (session) =>
          session.agentId === agentId &&
          session.projectId === input.goal.projectId &&
          session.presence === 'online' &&
          session.status !== 'starting' &&
          session.status !== 'completed' &&
          session.status !== 'disconnected',
      )
        ? 'online'
        : 'absent',
    ]),
  );
  const base: Record<string, unknown> = {
    now: input.nowIso,
    goal: {
      id: input.goal.id,
      title: input.goal.title,
      objective: clip(input.goal.objective, 16_000),
      acceptanceCriteria: input.goal.acceptanceCriteria,
      state: input.goal.state,
      planVersion: input.goal.planVersion,
      budget: input.goal.budget,
      usage: input.goal.usage,
      ...(input.goal.answer === undefined ? {} : { operatorAnswer: clip(input.goal.answer.text) }),
      ...(input.goal.escalation === undefined
        ? {}
        : {
            lastEscalation: {
              reason: input.goal.escalation.reason,
              question: clip(input.goal.escalation.question, 1000),
            },
          }),
    },
    policy: {
      workers: input.workers,
      workerPresence,
      ...(input.workerRoles === undefined ? {} : { workerRoles: input.workerRoles }),
      reviewer: input.policy.reviewerAgentId ?? null,
      protectedPaths: input.policy.protectedPaths,
      maxInFlight: input.policy.maxInFlight,
      defaultTaskTimeoutMs: input.policy.defaultTaskTimeoutMs,
    },
    ...(input.git === undefined ? {} : { git: input.git }),
    heldLeases: input.leases.slice(0, 50),
    tasks: input.tasks.map(taskSummary),
    ...(input.reviewTask === undefined ? {} : { reviewTask: taskSummary(input.reviewTask) }),
    ...(input.reviewAnswer === undefined
      ? {}
      : {
          reviewerAnswer: {
            status: input.reviewAnswer.status,
            answer: clip(input.reviewAnswer.answer, ANSWER_CAP),
          },
        }),
    ...(input.repairErrors === undefined || input.repairErrors.length === 0
      ? {}
      : { previousAnswerRefused: input.repairErrors.slice(0, 20) }),
  };
  const retrospectives = input.retrospectives.slice(0, input.policy.retrospectives).map((item) => ({
    summary: clip(item.summary, 2000),
    workerNotes: item.workerNotes,
    writtenAt: item.writtenAt,
  }));
  const limit = input.maxBytes ?? ORCHESTRATOR_CONTEXT_MAX_BYTES;
  const fits = (candidate: Record<string, unknown>): boolean =>
    Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= limit;
  let context: Record<string, unknown> = { ...base, retrospectives };
  if (fits(context)) return context;
  context = { ...base, retrospectives: [] };
  if (fits(context)) return context;
  const compactTasks = input.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    state: task.state,
  }));
  context = { ...base, tasks: compactTasks, retrospectives: [] };
  if (fits(context)) return context;
  context = {
    ...context,
    goal: { ...(context['goal'] as object), objective: clip(input.goal.objective, 2000) },
  };
  if (fits(context)) return context;
  // Last resort: drop the oldest tasks until it fits, and say how many went.
  // A bounded context the brain can read beats a complete one it never receives.
  for (let omitted = 1; omitted <= compactTasks.length; omitted += 1) {
    const trimmed = { ...context, tasks: compactTasks.slice(omitted), tasksOmitted: omitted };
    if (fits(trimmed)) return trimmed;
  }
  return { ...context, tasks: [], tasksOmitted: compactTasks.length };
}

const ANSWER_SHAPES: Record<JudgmentKind, string> = {
  plan: `{"kind":"plan","decision":{"tasks":[{"title":"…","brief":"…","agentId":"<one of policy.workers>","paths":["project/relative/path"],"dependsOn":[<indices of earlier tasks>],"evidenceRequirements":["git_commit"|"test_result"|"file_reference"|…],"doneCriteria":"…"}],"rationale":"…","confidence":0.0-1.0}}`,
  review: `{"kind":"review","decision":{"verdict":"accept"|"rework"|"escalate","feedback":"…","confidence":0.0-1.0}}`,
  replan: `{"kind":"replan","decision":{"keep":["<ids of current non-terminal tasks to keep>"],"add":[<tasks as in a plan>],"giveUp":"<optional reason to stop the goal>","rationale":"…","confidence":0.0-1.0}}`,
  summarize: `{"kind":"summarize","decision":{"summary":"…","workerNotes":{"<agentId>":"…"}}}`,
};

const QUESTIONS: Record<JudgmentKind, string> = {
  plan: 'Plan the goal as an ordered list of tasks for the listed workers. Each task is one bounded piece of work a worker completes unattended in one headless run: name the files it may touch under paths, the evidence it must return, and what done means. Assign each task to the worker whose lane fits it: policy.workerRoles gives each worker its role (its free-text specialty, e.g. mobile/Flutter vs backend/contracts/DB) and flowRoles — match the task to that specialty and do not default every task to one worker. Declare no path only when the task genuinely touches the whole project. Never assign a worker that is absent or not listed. Keep the plan within budget.maxTasks.',
  review:
    "Judge the task under review against the goal's acceptance criteria, the task's doneCriteria, the deterministic checks and the reviewer's answer when present. accept only what the evidence supports; rework with concrete feedback when a bounded follow-up would fix it; escalate when a human must decide.",
  replan:
    'The goal cannot continue as planned. Using the operator answer, the failed or reworked tasks and the outcomes so far, decide which current non-terminal tasks to keep and which new tasks to add — or give up with a reason if the goal is not achievable within its budget.',
  summarize:
    'The goal is over. Write a short retrospective for the next plan: what worked, what did not, and one note per worker about how reliable it was.',
};

/** Fixed, visible framing; the context is the only variable part. */
export function frameJudgment(kind: JudgmentKind, context: Record<string, unknown>): string {
  return [
    `LUWI autopilot judgment: ${kind}.`,
    'You are the orchestrator brain for one project. You decide; you do not act — you have no tools and must not attempt to edit files, run commands or send messages. Workers are separate agents that receive your tasks as messages.',
    QUESTIONS[kind],
    `Answer with exactly one JSON object and nothing else, of this shape: ${ANSWER_SHAPES[kind]}`,
    'CONTEXT:',
    JSON.stringify(context),
  ].join('\n\n');
}

export type ParsedJudgment =
  { ok: true; decision: JudgmentDecision } | { ok: false; errors: string[] };

function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseJudgment(kind: JudgmentKind, text: string): ParsedJudgment {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, errors: ['The answer contains no JSON object.'] };
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    return { ok: false, errors: [`The JSON does not parse: ${(error as Error).message}`] };
  }
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const wrapped =
    record['kind'] === undefined && record['decision'] === undefined
      ? { kind, decision: value }
      : { ...record, kind: record['kind'] ?? kind };
  const parsed = judgmentDecisionSchema.safeParse(wrapped);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  if (parsed.data.kind !== kind) {
    return { ok: false, errors: [`Expected a ${kind} decision, got ${parsed.data.kind}.`] };
  }
  return { ok: true, decision: parsed.data };
}

/** Policy checks the schema cannot make: workers, dependency order, budget. */
export function validatePlannedTasks(
  tasks: readonly PlannedTask[],
  input: { workers: readonly string[]; maxTasks: number; alreadyPlanned: number },
): string[] {
  const errors: string[] = [];
  if (tasks.length + input.alreadyPlanned > input.maxTasks) {
    errors.push(
      `The plan has ${String(tasks.length)} tasks and the goal already counts ${String(input.alreadyPlanned)}; the budget is ${String(input.maxTasks)}.`,
    );
  }
  tasks.forEach((task, index) => {
    if (!input.workers.includes(task.agentId)) {
      errors.push(
        `tasks[${String(index)}].agentId ${task.agentId} is not one of the workers: ${input.workers.join(', ') || 'none'}.`,
      );
    }
    for (const dependency of task.dependsOn) {
      if (dependency >= index) {
        errors.push(
          `tasks[${String(index)}].dependsOn refers to task ${String(dependency)}, which is not earlier in the plan.`,
        );
      }
    }
  });
  return errors;
}
