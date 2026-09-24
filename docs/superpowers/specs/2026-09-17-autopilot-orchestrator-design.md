# Autopilot orchestrator design — a LUWI-owned agentic loop with a pluggable brain

Date: 2026-09-17. Companion to `2026-09-17-project-autopilot-design.md` (the substrate: mode, policy,
tasks, dispatch, notices) and ADR 0035 (Proposed). Written after the owner's read of the first draft:
"only the orchestrator part is a bit thin — make it a more agentic structure". Nothing here is built.

## Problem

The substrate spec gives a coordinator a switch, a task store and a wake-up, and then stops: how the
coordinator turns an objective into tasks, judges a worker's result, recovers from a failure, learns
from the last goal and knows when to ask a human were left to "operating instructions" in a guide. An
orchestrator whose agency lives only in a prompt is neither testable nor visible, and its budget is
whatever the model felt like that day.

Two facts from the tree shape the answer:

1. ADR 0031 already proved the shape of a **LUWI-owned loop around a model**: the native bridge owns
   claim → run → complete, and the model owns only the work inside one headless run. The loop is
   deterministic and tested; the model is a pluggable executor behind `NativeBridgeExecutor`.
2. LuwiBot is reachable today over `ws://127.0.0.1:3100/chat` with `{ message, history }` →
   `{ reply } | { error }` (`apps/dashboard/src/components/luwibot-chat.tsx`). That is already an
   interface for asking a brain one bounded question.

## Goal

An orchestrator whose **loop belongs to LUWI** — perceive, plan, dispatch, verify, adapt, escalate,
remember — and whose **judgment belongs to a pluggable brain** (LuwiBot/Hermes over its WebSocket, or
any native CLI headless). Every autonomous step is a recorded runtime transition with a budget and a
gate; the brain is asked bounded, schema-validated questions and never holds the pen on the repository.

## Non-goals

No planning or model call inside the daemon: the loop is a CLI bridge like the worker bridges. The
orchestrator never edits files, runs tests or commits — every change to the repository is a worker's.
No LUWI-run verification command (execution of project code stays outside the runtime; see Deferred).
No goal self-generation before the `proactive` level, which is its own gate. No unbounded retries.

## Vocabulary

| Term          | Meaning                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| goal          | The unit of autonomy: an objective with acceptance criteria, a budget and a plan of tasks.                         |
| plan          | The goal's ordered task set, versioned; produced by a `plan` judgment, approved in `supervised`.                   |
| judgment      | One bounded question to the brain with a schema-validated answer: `plan`, `review`, `replan`, `summarize`.         |
| brain         | The judgment provider: `luwibot-ws`, or a native CLI headless (`claude`, `codex`, `gemini`, `hermes`).             |
| verification  | What happens after a task completes: deterministic checks, then an optional review task, then a `review` judgment. |
| rework        | A follow-up task the orchestrator creates from review feedback; bounded per task.                                  |
| escalation    | The goal parks `blocked` with one concrete question the operator answers.                                          |
| retrospective | A bounded record written when a goal ends; fed into the next `plan` judgment's context.                            |

## The agentic cycle

```
                 ┌────────────── perceive ──────────────┐
  notice/response│  goals · tasks · sessions · leases   │  tick (60 s)
                 └──────────────┬───────────────────────┘
                                ▼
                     planCycle(state) → actions            (pure, @luwi/runtime)
        ┌───────────────┬───────────────┬───────────────┬───────────────┐
        ▼               ▼               ▼               ▼               ▼
   judge(plan)     dispatch ready   verify done     judge(review)   escalate / finish
   (brain)         (substrate)      (deterministic)  (brain)         (operator)
        └───────────────┴───────────────┴───────────────┴───────────────┘
                                apply through the daemon HTTP API
                                every step = an event with a budget check
```

`planCycle` is a pure function from the observed state to a list of actions; the bridge executes them
in order and stops at the first refusal. One cycle runs per wake (an inbox item or the tick), and a
cycle never issues more than one judgment per goal, so a runaway brain costs one bounded call per wake.

### Goal lifecycle

```
proposed ──approve/auto──▶ planning ──plan accepted──▶ running ──all tasks done──▶ verifying ──▶ achieved
    │                          │  (supervised: plan_review)        │                        │
    │                          └──low confidence / invalid twice──▶ blocked ◀── budget / scope / rework limit
    └──abandon──▶ abandoned                                          │
                                                          answered ──┘──▶ planning | running | abandoned
                                                                             failed (budget exhausted with no path)
```

```ts
type GoalState =
  | 'proposed'
  | 'planning'
  | 'plan_review'
  | 'running'
  | 'verifying'
  | 'blocked'
  | 'achieved'
  | 'failed'
  | 'abandoned';

type Goal = {
  id: string;
  projectId: string;
  title: string; // 1..200
  objective: string; // 1..32 768 bytes — what "done" means, in the operator's words
  acceptanceCriteria: string[]; // ≤ 16 × 500; the review judgment is asked against these
  createdBy:
    | { kind: 'operator' }
    | { kind: 'session'; sessionId; agentId }
    | { kind: 'signal'; source: string; ref: string };
  budget: {
    maxTasks: number;
    maxReworksPerTask: number;
    maxReplans: number;
    maxWallClockMs: number;
    minConfidence: number;
  };
  state: GoalState;
  planVersion: number; // bumps on every accepted plan/replan
  taskIds: string[]; // the current plan, in dependency order
  escalation?: { question: string; options?: string[]; askedAt: string; reason: EscalationReason };
  answer?: { text: string; at: string };
  usage: { tasks: number; reworks: number; replans: number; judgments: number; startedAt?: string };
  retrospective?: { summary: string; workerNotes: Record<AgentId, string>; writtenAt: string }; // ≤ 8 KiB
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

Budget defaults come from the policy (`goalDefaults`) and may be lowered, never raised, per goal at
creation by a session; only the operator may raise them.

### Judgments: bounded questions, validated answers

Every judgment is `JudgmentRequest → JudgmentDecision`, both `@luwi/protocol` schemas
(`orchestrator.ts`). The bridge assembles the context, frames it with fixed visible text (the
`framePrompt` discipline), sends it to the brain, validates the answer, and records
`orchestrator.judgment.decided { goalId, kind, brain, confidence, decisionSummary, promptSha256, ms }` —
never the prompt itself (§4 logging rules).

| Kind        | Asked when                                           | Answer                                                                                                                          |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `plan`      | goal enters `planning`                               | `{ tasks: [{ title, brief, agentId, paths, dependsOn (indices), evidenceRequirements, doneCriteria }], rationale, confidence }` |
| `review`    | a task's deterministic checks ran                    | `{ verdict: 'accept' \| 'rework' \| 'escalate', feedback, confidence }`                                                         |
| `replan`    | a task failed, a rework limit hit, an answer arrived | `{ keep: taskId[], cancel: taskId[], add: [...tasks], rationale, confidence }`                                                  |
| `summarize` | goal ends                                            | `{ summary, workerNotes }` → the retrospective                                                                                  |

Rules that make the brain safe to trust with agency:

- **Context is assembled by LUWI, bounded and inspectable**: the goal, the policy, the worker roster
  with presence, the last N task outcomes of this goal, the last M retrospectives of this project, held
  leases, the git head and branch, and the knowledge-graph neighbourhood of the paths named so far —
  each part capped, total ≤ `LUWI_ORCHESTRATOR_CONTEXT_MAX_BYTES` (default 64 KiB), assembled by a pure
  `assembleJudgmentContext` with a test per cap.
- **An answer is validated, then policy-checked**: a plan naming a worker outside the policy, a path
  outside the project, more tasks than the budget, or a dependency cycle is sent back **once** with the
  exact refusals; a second invalid answer escalates the goal (`reason: brain_invalid`). Nothing is
  silently dropped or auto-corrected.
- **Confidence is a gate, not a decoration**: a decision under `budget.minConfidence` is not applied;
  the goal escalates with the brain's own rationale as the question.
- **The brain never acts**: it answers questions. The bridge applies decisions through the same gated
  daemon routes the coordinator tools use, so every effect is a substrate transition with its event.

### Brain adapters

```ts
interface BrainAdapter {
  judge(request: FramedJudgment): Promise<{ text: string; ms: number }>;
}
```

| Adapter      | Transport                                                                        | Notes                                                                                               |
| ------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `luwibot-ws` | the existing LuwiBot WebSocket, one `{ message }` per judgment, no history       | Hermes' memory and skills act inside the answer; the operator chats with the same brain that plans. |
| `native`     | one headless run of `claude`/`codex`/`gemini`/`hermes` via the ADR 0031 executor | `--` args are its whole permission model; for judgments they should be read-only tools.             |

Both are chosen on the command line, both are loopback-only, both receive no Redis credentials. The
adapter is a seam: `orchestrator.test.ts` runs the whole cycle against a scripted fake brain.

### Verification: deterministic first, a reviewer second, the brain last

When a dispatched task completes, `verifyTaskOutcome` (pure) runs before any judgment:

| Check              | Source                                                                                | Failure signal                      |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------- |
| required evidence  | the message response's `evidence[]` types vs the task's requirements                  | `evidence_missing`                  |
| commit exists      | `git_commit` evidence vs the project's Git observation (`…/git/commits`)              | `evidence_unverified`               |
| commit attribution | the commit's attribution (ADR 0017) names the worker's session or agent               | `attribution_mismatch`              |
| scope              | files the worker changed (ADR 0023 B2 observations for that session) ⊆ declared paths | `scope_exceeded`                    |
| leases             | the worker acquired leases over its paths (`lease.acquired` for its session)          | `unleased` (advisory, never blocks) |
| test claim         | `test_result` evidence with `metadata.outcome: 'passed'`                              | `tests_unclaimed`                   |

Then, when the policy sets `reviewer` (an agent id that is not the author), the orchestrator creates a
**review task** — `readOnlyReviewer` from the dormant `projectRole` schema, finally consumed — whose
brief carries the original brief, the done criteria and the checks, and whose worker is a different
vendor than the author when one is available (an independent second reading is what "ship without
collisions" needs at the semantic level). The review task's answer is evidence for the `review`
judgment. Only then is the brain asked `review`, with the checks and the reviewer's answer in context.

`accept` marks the task verified and the goal advances; `rework` creates one follow-up task
(`reworkOf`, the feedback in its brief) while `usage.reworks < maxReworksPerTask`; `escalate`, or a
rework past the limit, or `scope_exceeded`, parks the goal `blocked` with a question that names the
task, the check and the evidence.

### Escalation: one concrete question, answered by the operator

A `blocked` goal carries exactly one `escalation` (question, optional options, reason:
`budget_exhausted | rework_limit | scope_exceeded | low_confidence | brain_invalid | protected_path |
worker_unavailable`). The dashboard and `luwi goal answer` deliver the operator's answer; the answer is
a `goal_answered` notice to the orchestrator, which runs a `replan` judgment with the answer in
context. `abandon` ends the goal. No escalation is ever answered by the brain.

### Memory: a bounded retrospective, in the open

At `achieved | failed | abandoned` the orchestrator asks `summarize` and stores the result on the goal
(≤ 8 KiB) and in `index:project:{id}:retrospectives` (bounded to 20; older ones fall off). The next
`plan` judgment for the project receives the newest M (policy `memory.retrospectives`, default 5). This
is the whole memory the runtime provides: explicit, capped, readable in the drawer, rebuildable from
events. Hermes may keep its own memory behind the `luwibot-ws` adapter; the runtime neither reads it
nor depends on it.

### Autonomy ladder

| Mode         | Plan                        | Dispatch                                  | Rework / replan          | Escalates on                                               | Goals from                        |
| ------------ | --------------------------- | ----------------------------------------- | ------------------------ | ---------------------------------------------------------- | --------------------------------- |
| `off`        | —                           | —                                         | —                        | —                                                          | —                                 |
| `supervised` | operator approves           | approved plan flows; protected paths gate | operator approves        | every reason above                                         | operator, LuwiBot chat            |
| `autopilot`  | automatic ≥ `minConfidence` | within budgets; protected paths gate      | automatic within budgets | budget, rework limit, scope, low confidence, brain invalid | operator, LuwiBot chat            |
| `proactive`  | as `autopilot`              | as `autopilot`                            | as `autopilot`           | as `autopilot`                                             | **plus** allowlisted LUWI signals |

`proactive` is a later phase and its own gate: goal sources are an allowlist in the policy —
optimization findings (`…/optimization/findings`), config drift records, and verification failures
that recur — each generated goal starts `proposed` with `createdBy.kind: 'signal'` and follows the
same lifecycle; the policy caps `maxOpenSignalGoals` (default 1). Nothing else on this machine may
become a goal without a person or a signal on that list.

**Plan approval is bulk task approval.** In `supervised`, approving a plan (or a replan/rework) marks
its tasks `approved` in one transition, so the substrate's dispatch gate (`gated: supervised` for a
task not `approved`) is unchanged; a task the orchestrator adds later is gated until its plan revision
is approved. Protected paths gate at dispatch in every mode.

### Budgets, all of them

| Budget                                | Scope   | Default   | Enforced by                                 |
| ------------------------------------- | ------- | --------- | ------------------------------------------- |
| `maxTasks`                            | goal    | 12        | plan/replan validation                      |
| `maxReworksPerTask`                   | goal    | 1         | verification                                |
| `maxReplans`                          | goal    | 2         | replan trigger                              |
| `maxWallClockMs`                      | goal    | 4 h       | every cycle (→ `blocked: budget_exhausted`) |
| `minConfidence`                       | goal    | 0.6       | every judgment                              |
| `maxJudgmentsPerHour`                 | project | 30        | the bridge, before calling the brain        |
| `maxConcurrentGoals`                  | project | 1         | goal start                                  |
| `maxInFlight`, `maxDispatchesPerHour` | project | substrate | `luwi_task_dispatch_v1`                     |
| context bytes per judgment            | bridge  | 64 KiB    | `assembleJudgmentContext`                   |
| judgment wall time                    | bridge  | 5 min     | executor deadline / WebSocket timeout       |

## The bridge

```
luwi session bridge orchestrator --project <id> --brain <luwibot-ws|claude|codex|gemini|hermes>
   [--brain-url ws://127.0.0.1:3100/chat] [--tick-ms 60000] [--bridge-instance orchestrator]
   [--heartbeat-ms 5000] [--connect-timeout-ms 2000] [--url …] [-- brainArgs...]
```

- Registers one session for the policy's `coordinatorAgentId` through `createSessionBootstrap`
  (metadata `{ bridge: 'orchestrator', brain }`), sets it `idle`, and is the coordinator the substrate
  already expects: notices and worker responses land in its inbox; task writes carry its session id.
- Loop: `claimInbox(block 30 s)` → on any item, or when `tick-ms` elapsed → `perceive()` (goals,
  tasks, sessions, leases, autopilot record — bounded reads) → `planCycle(state)` → execute actions →
  report one line per action to stdout (`goalId`, action, outcome; no prompt text).
- `off` observed at perceive: the loop idles (heartbeat only) and logs once; a running worker task is
  left to finish or time out, as the substrate says.
- Stop: `SIGINT`/`SIGTERM` finish the current action, close the session; an in-flight judgment is
  abandoned (its goal stays where it was; the next bridge resumes from the store — the loop holds no
  private state).
- `luwi autopilot up --project <id>` (optional, Phase 4): starts this bridge and, when the policy carries
  `workerLaunch: { [agentId]: argv }`, one `session bridge native` per worker with those exact
  arguments — the operator's permission decisions, stored canonically and shown in the drawer.

## Substrate additions this needs

| Layer     | Addition                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol  | `goal.ts` (goal, budget, escalation, retrospective schemas), `orchestrator.ts` (judgment request/decision schemas, context caps); task gains `goalId`, `reworkOf?`, `doneCriteria?`, `verification?`                                                                                                                                                                                                 |
| Policy    | `reviewer?: AgentId`, `goalDefaults`, `memory.retrospectives`, `maxJudgmentsPerHour`, `maxConcurrentGoals`, `workerLaunch?`, `signalSources?` (proactive)                                                                                                                                                                                                                                            |
| Redis     | `goal:{id}`, `index:project:{id}:goals` (zset), `index:goal:{id}:tasks` (zset), `index:project:{id}:retrospectives` (zset, capped 20); Functions `goal_create`, `goal_transition` (CAS), `goal_plan_put` (records the accepted task-id list and bumps `planVersion`; tasks are created one by one through `task_create` first, and reconciliation cancels `ready` tasks that no recorded plan names) |
| Events    | `goal.created                                                                                                                                                                                                                                                                                                                                                                                        | planned                                                                                                                        | plan.approved | started      | replanned | escalated                                                         | answered | achieved | failed | abandoned`, `task.verified`, `task.rework.created`, `orchestrator.judgment.decided` |
| HTTP      | `GET …/projects/:id/goals`, `POST …/projects/:id/goals`, `GET …/goals/:id`, `POST …/goals/:id/plan/approve                                                                                                                                                                                                                                                                                           | reject`, `POST …/goals/:id/answer`, `POST …/goals/:id/abandon`(operator);`POST …/goals/:id/plan`, `…/transition` (coordinator) |
| MCP       | `luwi_list_goals`, `luwi_get_goal` (reads); `luwi_create_goal` (any bound session — this is how LuwiBot chat turns "add a goal" into a goal); nothing that approves, answers or abandons                                                                                                                                                                                                             |
| CLI       | `luwi goal list                                                                                                                                                                                                                                                                                                                                                                                      | show                                                                                                                           | create        | approve-plan | answer    | abandon`; `luwi session bridge orchestrator`; `luwi autopilot up` |
| Dashboard | Goals in the Autopilot section: goal card (state chip, `3/7 tasks`, budget used, plan as an ordered list with verification verdicts), the escalation question with an answer box and Approve plan / Abandon; retrospective under an achieved goal; the tile chip carries the open goal count                                                                                                         |

## Safety invariants (each one a test)

1. The orchestrator holds no pen: it never spawns anything but a brain judgment, never edits files,
   and every repository change traces to a worker session.
2. One judgment per goal per cycle; `maxJudgmentsPerHour` per project; context ≤ 64 KiB; judgment wall
   time bounded.
3. An invalid answer is sent back once with the refusals and then escalates; nothing is auto-corrected.
4. A decision under `minConfidence` is never applied.
5. Every autonomous transition is a substrate transition with an event and a budget check; the loop
   holds no private state, so a restarted bridge resumes from the store.
6. Rework is bounded per task; replan per goal; wall clock per goal; open goals per project.
7. `scope_exceeded` always escalates — a worker that wrote outside its declared paths is never accepted
   automatically.
8. The brain never answers an escalation; only the operator does.
9. `proactive` goal sources are an allowlist with a cap; a generated goal starts `proposed`.
10. The prompt is never logged or stored; its hash and the decision are.

## Failure modes, stated

| Failure                                  | Behaviour                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brain unreachable / times out            | The judgment is not recorded as decided; the goal stays where it was; retried next wake up to `maxJudgmentsPerHour`; after three consecutive failures the goal escalates `brain_invalid`. |
| Brain returns prose, not JSON            | One repair round with the parse error; then escalation.                                                                                                                                   |
| Worker exceeds its declared paths        | `scope_exceeded` → escalation; the task is not accepted; the operator decides.                                                                                                            |
| Reviewer worker unavailable              | The review task is skipped and the `review` judgment sees "no independent review"; in `autopilot` a task that changed protected paths then escalates instead of being accepted.           |
| Bridge dies mid-cycle                    | Nothing is half-applied that the store does not show; the next bridge perceives and continues.                                                                                            |
| Two orchestrator bridges for one project | Both perceive; goal and task CAS make the second writer lose; `maxConcurrentGoals` holds.                                                                                                 |
| Operator sets `off` mid-goal             | The goal stays `running` with no new dispatch or judgment; the drawer says "paused by mode".                                                                                              |

## Testing (§15)

- `@luwi/runtime`: `planCycle` table-driven over every goal/task state combination; judgment schema
  validation and the one-repair-round rule; `assembleJudgmentContext` caps; `verifyTaskOutcome` per
  check; budget arithmetic; escalation reasons.
- Bridge: the whole cycle against a scripted fake brain and a fake daemon — plan → dispatch → response
  → verify → review task → accept → achieved; rework once then escalate; low confidence; invalid twice;
  `off` mid-goal; restart resumes.
- Redis integration: goal Functions, plan-put CAS, retrospective cap, reconciliation of orphan tasks.
- Dashboard: goal card states, answer flow, approve-plan flow, allowlist and class/token guards.
- Live (Phase 4): one real project, LuwiBot as `luwibot-ws` brain, `claude-code` author and `codex`
  reviewer bridges; a small real goal end to end in `supervised`, then in `autopilot`; measured report.

## Phase 0 measurements this design adds

| Question                                                                                     | Why it matters                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Does the LuwiBot WebSocket accept a long single message (≥ 64 KiB) and answer JSON reliably? | Decides whether `luwibot-ws` can be a brain adapter at all.                                       |
| Latency and cost of one judgment over the WebSocket vs a headless `hermes` run               | Sets the tick and `maxJudgmentsPerHour` defaults.                                                 |
| Does Hermes keep server-side conversation state per socket?                                  | The adapter sends no history; its memory must come from Hermes itself or from the retrospectives. |
| Can a headless `hermes`/`claude` judgment run with read-only tools only?                     | Invariant 1: the brain must not be able to edit while judging.                                    |

## Deferred, with reasons

| Item                                    | Reason                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LUWI running the project's test command | Executing project code crosses the never-execute boundary the adapters and scanners keep; if wanted, it is a separate ADR with an owned-process runner and its own permission surface. |
| Multi-goal scheduling / priorities      | `maxConcurrentGoals` = 1 first; a queue is a later phase once one goal end-to-end is measured.                                                                                         |
| Cross-project goals                     | Tasks follow messages, which are same-project (ADR 0006).                                                                                                                              |
| Brain-to-brain negotiation              | Two brains disagreeing is an escalation, not a protocol.                                                                                                                               |
| Automatic PR / merge                    | §21 GitHub integration is out of scope.                                                                                                                                                |
