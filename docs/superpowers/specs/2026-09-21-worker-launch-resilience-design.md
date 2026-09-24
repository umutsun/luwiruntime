# Worker-launch resilience — design (NEW SCOPE, owner approval required)

Status: **proposed, not built.** ADR 0035 today is deliberately fail-and-escalate
(`docs/decisions/0035-project-autopilot-coordination.md:205`: *"No blind retries — a failed task
stays failed; the orchestrator may create one bounded rework from review feedback, and a rework past
its limit escalates."*). This adds a bounded retry/fallback path, so it needs its own approval.

## Motivating incident (2026-09-21)

The Codex desktop app auto-updated at 17:59 and deleted the versioned `codex.exe` the running codex
bridge was launched with (`…/OpenAI/Codex/bin/<hash>/codex.exe`). The bridge then looped
`AGENT_EXECUTABLE_NOT_FOUND` every 250 ms; every dispatched **verify** task ended `failed` with the
generic reason *"The native agent process could not start or exited abnormally."* The operator saw
only idle + generic failures — no signal that codex's binary had vanished. The fleet manager, which
re-resolves the newest exe at launch (`resolveCodexExecutable`), was not running, so nothing
self-healed it.

Two lessons this design encodes:

1. A **blind same-worker retry would not have helped** — the exe was gone; retrying the same launch
   fails identically. Retry is only correct for a **transient** failure. A **persistent** failure
   (missing exe, usage cap, worker offline) must **fall back to another worker or escalate with the
   real reason** — never spin.
2. The operator-facing gap was **honesty**, not automation: the failure must carry *why*
   ("executable not found", "usage limit", "target offline"), not a catch-all string.

## §21 placement (binding)

The decision is a pure function; the execution is the CLI orchestrator. **Nothing goes in the
daemon.** `AGENTS.md:1305-1308`: *"nothing here adds a daemon-side flow engine, scheduler, or
auto-advance."* Teaching `autopilot-service.ts`'s `completeFromMessage`/`complete` to auto-redispatch
on a `failed` message would be exactly that — forbidden. The daemon stays one gated transition per
call; the "try again / try another worker" policy lives in:

- **`packages/runtime/src/orchestrator-cycle.ts` (`planCycle`, pure)** — decides.
- **`apps/cli/src/orchestrator-bridge.ts` (the CLI loop)** — executes, through already-gated daemon
  routes. This is the ADR 0035 carve-out (`AGENTS.md:1346-1347`).

## Mechanism (minimal)

1. **Classify the terminal outcome** (the bridge already knows it; surface it on the failed
   message/task so the pure cycle can read it):
   - `launch_failed` — spawn/exec could not start (`AGENT_SPAWN_FAILED` / executable not found).
   - `worker_offline` — no online target session at dispatch (`worker_unavailable` today,
     `autopilot-service.ts:442-462`).
   - `abnormal_exit` — process exited non-zero without completing (may be transient, e.g. a flaky
     command; may be persistent, e.g. a usage cap the tail names).
   - `timed_out` — deadline passed.
   - (`rework` stays what it is: a review **verdict**, not a launch failure — untouched.)

2. **A new task counter `dispatchAttempts`** (mirror `reworkCount`, `task-state.ts`), incremented
   **only** on a launch/transient failure — kept distinct from `reworkCount` so a crash never eats a
   rework budget and vice-versa.

3. **A new pure `CycleAction`** `{ type: 'redispatch', taskId, toAgent? }`
   (`orchestrator-cycle.ts:30-44`), gated by a small per-goal budget
   (`goal.budget.maxDispatchRetries`, default 1–2):
   - **Transient** (`timed_out`, first `abnormal_exit`) under budget → redispatch the **same** task
     to the **same** worker after a short backoff.
   - **Persistent** (`launch_failed`, `worker_offline`, repeated `abnormal_exit`) → **fall back** to
     another eligible worker from `effectiveWorkers` **that carries the same flow role** (a verifier
     task only falls back to another verifier). No eligible fallback → **escalate** immediately.
   - Budget exhausted → **escalate** (park the goal, one operator question) — as today, but with the
     **concrete reason** attached.

4. **Honest reason surfacing** — the escalation `question` / task failure carries the classified
   reason and, where present, the native-output tail's own line (e.g. the codex usage-limit or
   "executable not found" line), so the cockpit shows *why*.

## Explicitly excluded (ponytail + §21)

- **No daemon-side retry / queue / timer.** The daemon never redispatches on its own.
- **No blind or unbounded retry.** Every path is budget-bounded and ends in escalate.
- **No auto-relaunch of the native process.** Respawning a dead bridge with a fresh exe is the
  **manager's** job (`resolveCodexExecutable` at launch); this design routes *around* a broken
  worker, it does not resurrect it.
- **No cross-role fallback.** A verifier task never falls back to an implementer; if no same-role
  worker is free, escalate.

## Sibling fix (not this scope, noted)

The manager's supervisor retires a worker only when its **session goes offline**
(`manager.mjs:166`). A bridge whose exe vanished stays **online** while every dispatch fails — the
supervisor never catches it. A manager-side health signal ("online but N consecutive dispatch
failures → retire + relaunch") would have auto-healed the motivating incident. That lives in the
`~/.luwi/managed-agents` scaffold, is owner-owned, and is separate from this daemon/CLI design.

## Test surface (when built)

- Pure `planCycle` unit tests: each outcome class → the right action (transient→same-worker
  redispatch; persistent→fallback or escalate; budget-exhausted→escalate-with-reason;
  cross-role fallback refused).
- `task-state` test: `dispatchAttempts` increments only on launch/transient failure, never on a
  review `rework`, and vice-versa.
- No new Redis/protocol Function unless the task record gains `dispatchAttempts` (a record-shape
  change would move `luwi_v1`; a computed/transient field would not — decide at build time).
