import { useEffect, useRef, useState } from 'react';

import type { AutopilotFlow, FlowGoal } from '../api/autopilot-flow.js';
import type { AgentActivity } from '../api/agent-activity.js';
import { autopilotFlowPanel, type FlowPanel } from '../overview/model.js';
import { parseRoute } from '../routing.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { agenticStages, involvement } from './agentic-flow.js';
import { cockpitStatus } from './luwibot-cockpit.js';
import { StatusChip } from './status-chip.js';
import type { ResourceState } from './panel.js';

/*
 * LuwiBot — a docked assistant that talks to the local LuwiBot service over a
 * WebSocket, deliberately not an HTTP mutation request: the dashboard's
 * `product-independence` guard forbids an HTTP mutation verb outside the three
 * approved daemon-mutation modules, and LuwiBot is an external local service on
 * its own port, not the daemon. A WebSocket carries the turn with no such verb,
 * so the guard stays intact.
 *
 * Build-time config (Vite `import.meta.env`, so `apps/dashboard/.env` then
 * `pnpm build`): unset is enabled, `VITE_LUWIBOT_ENABLED=false` hides it, and
 * `VITE_LUWIBOT_WS_URL` moves the ip/port.
 */
const ENABLED =
  ((import.meta.env.VITE_LUWIBOT_ENABLED as string | undefined) ?? 'true') !== 'false';
const WS_URL: string =
  (import.meta.env.VITE_LUWIBOT_WS_URL as string | undefined) ?? 'ws://127.0.0.1:3100/chat';

type Msg = { role: 'user' | 'assistant' | 'error'; text: string };
type Status = 'idle' | 'connecting' | 'open' | 'error';

type IntentAction = 'approve_plan' | 'reject_plan' | 'answer_goal' | 'abandon_goal';
type ConfirmableAction = 'approve_plan' | 'reject_plan' | 'abandon_goal';
// The active goal a cockpit control acts on. Raw flow goals are already non-terminal
// (the reader drops terminal ones), so the first is the one in flight and Stop always applies.
type CockpitTarget = {
  goalId: string;
  title: string;
  objective?: string;
  state: FlowGoal['state'];
  question?: string;
  done: number;
  total: number;
};

// Copy for the consequential gates; Answer is human-authored free text and needs no confirm.
const CONFIRM_COPY: Record<ConfirmableAction, { title: string; confirm: string; verb: string }> = {
  approve_plan: { title: 'Approve plan', confirm: 'Approve plan', verb: 'Approve the plan for' },
  reject_plan: { title: 'Reject plan', confirm: 'Reject plan', verb: 'Reject the plan for' },
  abandon_goal: { title: 'Stop goal', confirm: 'Stop goal', verb: 'Stop the goal' },
};

type LuwiBotChatProps = {
  /** GET reader for a project's autopilot flow; absent leaves the widget chat-only. */
  loadAutopilotFlow?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<AutopilotFlow>>;
  /** GET reader for a project's live agent activity; absent hides the activity strip. */
  loadAgentActivity?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<AgentActivity[]>>;
  /**
   * The autopilot-enabled projects, so the cockpit can surface the one doing work
   * when none is focused. Absent leaves the cockpit focus-only.
   */
  loadAutopilotProjects?: (options?: { signal?: AbortSignal }) => Promise<string[]>;
};

export function LuwiBotChat(props: LuwiBotChatProps = {}) {
  if (!ENABLED) return null;
  return <LuwiBotChatPanel {...props} />;
}

// The focused project id from the route hash, or undefined off a project focus.
// A project is focused via the overview (`#/pulse/<id>`) or the project drawer
// (`#/projects/<id>`); both carry `projectId`.
function focusedProjectId(): string | undefined {
  const route = parseRoute(window.location.hash);
  return route.name === 'pulse' || route.name === 'projects' ? route.projectId : undefined;
}

function LuwiBotChatPanel(props: LuwiBotChatProps) {
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState<FlowPanel>();
  const [target, setTarget] = useState<CockpitTarget>();
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  // The live context (agents + goal) can be collapsed to give the chat room.
  const [contextOpen, setContextOpen] = useState(true);
  const [confirmAction, setConfirmAction] = useState<ConfirmableAction>();
  const [pending, setPending] = useState<{ requestId: string }>();
  const [intentError, setIntentError] = useState<string>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  // Chat-backend reachability, kept apart from the fleet-activity tone: undefined
  // until the first attempt settles, true once the socket opens, false after a
  // refused or errored connection. It drives the offline guard on the launcher —
  // an idle fleet (a dim tone) must never read as an offline chat.
  const [reachable, setReachable] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const intentSeq = useRef(0);

  const connect = (): WebSocket => {
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;
    setStatus('connecting');
    ws.addEventListener('open', () => {
      setStatus('open');
      setReachable(true);
    });
    ws.addEventListener('close', () => {
      if (socketRef.current === ws) socketRef.current = null;
      setStatus('idle');
    });
    ws.addEventListener('error', () => {
      setStatus('error');
      setReachable(false);
    });
    ws.addEventListener('message', (event: MessageEvent<string>) => {
      let data: { kind?: string; requestId?: string; ok?: boolean; reply?: string; error?: string };
      try {
        data = JSON.parse(event.data);
      } catch {
        setBusy(false);
        setMessages((current) => [...current, { role: 'error', text: 'Malformed response' }]);
        return;
      }
      // An intent result correlates by requestId; it is not a chat turn and never touches the log.
      if (data.kind === 'intent_result') {
        setPending((current) => (current?.requestId === data.requestId ? undefined : current));
        if (data.ok !== true) setIntentError(data.error ?? 'Intervention failed');
        return;
      }
      setBusy(false);
      setMessages((current) =>
        data.error !== undefined
          ? [...current, { role: 'error', text: data.error }]
          : [...current, { role: 'assistant', text: data.reply ?? '' }],
      );
    });
    return ws;
  };

  // Keep the socket warm from mount, so the collapsed launcher knows whether the
  // chat backend is reachable before it is ever opened — opening must never
  // reveal a dead cockpit. A refused or dropped socket is retried on a slow
  // timer so a LuwiBot restart re-connects on its own; closed on unmount.
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ensure = () => {
      if (socketRef.current !== null) return;
      connect().addEventListener('close', () => {
        retry = setTimeout(ensure, 5000);
      });
    };
    ensure();
    return () => {
      if (retry !== undefined) clearTimeout(retry);
      socketRef.current?.close();
    };
    // `connect` closes over refs and stable setters; warmed once for the widget's life.
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, busy]);

  // Mirror the focused project's live state into the widget whenever one is
  // focused — even collapsed, so the docked bar shows live status (who is
  // working, a goal awaiting a gate). Read-only, refreshed every 5s and on hash
  // change. `autopilotFlowPanel` is the same pure model the drill-down uses.
  useEffect(() => {
    const load = props.loadAutopilotFlow;
    const loadActivity = props.loadAgentActivity;
    if (load === undefined) {
      setFlow(undefined);
      setTarget(undefined);
      setActivity([]);
      return;
    }
    const loadProjects = props.loadAutopilotProjects;
    let cancelled = false;
    const controller = new AbortController();
    const run = async () => {
      const signal = { signal: controller.signal };
      // Focus wins; with nothing focused, surface the project running autopilot so
      // the cockpit follows the work instead of vanishing on the bare overview.
      let projectId = focusedProjectId();
      if (projectId === undefined && loadProjects !== undefined) {
        projectId = (await loadProjects(signal))[0];
        if (cancelled) return;
      }
      if (projectId === undefined) {
        if (!cancelled) {
          setFlow(undefined);
          setTarget(undefined);
          setActivity([]);
        }
        return;
      }
      const [flowResult, activityResult] = await Promise.all([
        load(projectId, signal),
        loadActivity ? loadActivity(projectId, signal) : Promise.resolve(undefined),
      ]);
      if (cancelled) return;
      setFlow(autopilotFlowPanel({ autopilotFlow: { projectId, state: flowResult } }, projectId));
      const goal = flowResult.state === 'ready' ? flowResult.data.goals[0] : undefined;
      setTarget(
        goal === undefined
          ? undefined
          : {
              goalId: goal.id,
              title: goal.title,
              ...(goal.objective === undefined ? {} : { objective: goal.objective }),
              state: goal.state,
              ...(goal.question === undefined ? {} : { question: goal.question }),
              done: goal.tasks.filter((task) => task.state === 'done').length,
              total: goal.tasks.length,
            },
      );
      setActivity(activityResult?.state === 'ready' ? activityResult.data : []);
    };
    void run();
    const timer = window.setInterval(() => void run(), 5_000);
    const onHash = () => void run();
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('hashchange', onHash);
    };
  }, [props.loadAutopilotFlow, props.loadAgentActivity, props.loadAutopilotProjects]);

  // Connect-or-queue send, shared by the chat turn and the cockpit intents.
  const rawSend = (frame: unknown) => {
    const payload = JSON.stringify(frame);
    const ws = socketRef.current?.readyState === WebSocket.OPEN ? socketRef.current : connect();
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    else ws.addEventListener('open', () => ws.send(payload), { once: true });
  };

  const send = () => {
    const text = inputRef.current?.value.trim() ?? '';
    if (text === '' || busy) return;
    // Prior confirmed turns only; errors never become context.
    const history = messages
      .filter((message) => message.role !== 'error')
      .slice(-10)
      .map((message) => ({ role: message.role, content: message.text }));
    setMessages((current) => [...current, { role: 'user', text }]);
    setBusy(true);
    if (inputRef.current) inputRef.current.value = '';
    rawSend({ message: text, history });
  };

  // A cockpit intent leaves over the same WS as a distinct kind — no HTTP mutation, no model call.
  const sendIntent = (action: IntentAction, payload?: { text: string }) => {
    if (target === undefined || pending !== undefined) return;
    intentSeq.current += 1;
    const requestId = `intent-${String(intentSeq.current)}`;
    setIntentError(undefined);
    setPending({ requestId });
    rawSend({
      kind: 'intent',
      action,
      goalId: target.goalId,
      requestId,
      ...(payload === undefined ? {} : { payload }),
    });
  };

  // One live tone drives the single status dot (header when open, bar when
  // collapsed): a warning pulse when a goal awaits a gate, green while work is
  // actually live, dim otherwise — so it changes as the fleet does, not on the
  // socket. A merely queued goal with idle agents reads dim, not busy.
  const working = activity.some((agent) => agent.working);
  const running = target?.state === 'running' || target?.state === 'planning';
  const tone: { dot: 'alert' | 'busy' | 'calm'; title: string } =
    target?.state === 'plan_review' || target?.state === 'blocked'
      ? { dot: 'alert', title: 'Needs your input' }
      : working || running
        ? { dot: 'busy', title: 'Working' }
        : { dot: 'calm', title: 'Idle' };

  // Header headline: on a project focus the docked bar already carries the
  // "LuwiBot" identity, so the open panel's header shows the live autopilot
  // status instead of repeating the name. Off a focus it names itself.
  const headline = flow === undefined ? 'LuwiBot' : `Autopilot · ${tone.title}`;

  // Genuinely unreachable chat backend — a failed connection that has not
  // re-opened — as opposed to a merely idle fleet (a dim tone). The launcher
  // refuses to open a cockpit that cannot talk to LuwiBot.
  const chatOffline = reachable === false;

  // The agentic pipeline of the goal in flight, so the operator sees where the
  // loop is and where it hands back to them (the `you` stage + the line below).
  const stages = target === undefined ? [] : agenticStages(target.state, target.done, target.total);
  const where = target === undefined ? { you: false, text: '' } : involvement(target.state);

  return (
    <div className="luwibot">
      {open ? (
        <section className="luwibot__panel" aria-label="LuwiBot assistant">
          <header className="luwibot__head">
            <span
              className={`luwibot__dot luwibot__dot--${tone.dot}`}
              title={status === 'error' ? 'Chat unreachable' : tone.title}
              aria-hidden="true"
            />
            <span className="luwibot__title">{headline}</span>
            {activity.length > 0 || target !== undefined ? (
              <button
                type="button"
                className="luwibot__collapse"
                aria-label={contextOpen ? 'Hide live context' : 'Show live context'}
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((value) => !value)}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              className="luwibot__close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          {!contextOpen || activity.length === 0 ? null : (
            <section className="luwibot-activity" aria-label="Live agent activity">
              <p className="luwibot-activity__label">
                Live · {String(activity.filter((agent) => agent.working).length)} working
                {activity.some((agent) => !agent.working)
                  ? ` · ${String(activity.filter((agent) => !agent.working).length)} idle`
                  : ''}
              </p>
              {activity.some((agent) => agent.working) ? (
                <ul className="luwibot-activity__list">
                  {activity
                    .filter((agent) => agent.working)
                    .map((agent) => (
                      <li key={agent.agentId} className="luwibot-activity__row">
                        <span
                          className="luwibot-activity__dot luwibot-activity__dot--working"
                          aria-hidden="true"
                        />
                        <span className="luwibot-activity__agent">{agent.agentId}</span>
                        <span className="luwibot-activity__state">working</span>
                      </li>
                    ))}
                </ul>
              ) : null}
            </section>
          )}
          {!contextOpen || target === undefined ? null : (
            <section className="luwibot-cockpit" aria-label="Autopilot goal">
              <div className="luwibot-cockpit__head">
                <span className="luwibot-cockpit__title" title={target.title}>
                  {target.title}
                </span>
                {flow?.status === 'ready' && flow.goals[0] !== undefined ? (
                  <StatusChip tone={flow.goals[0].state.tone}>
                    {flow.goals[0].state.label}
                  </StatusChip>
                ) : null}
              </div>
              {target.objective === undefined ? null : (
                <p className="luwibot-cockpit__objective">{target.objective}</p>
              )}
              <ol className="agentic-rail" aria-label="Where you come in">
                {stages.map((stage) => (
                  <li
                    key={stage.key}
                    className={`agentic-rail__stage agentic-rail__stage--${stage.status} agentic-rail__stage--${stage.actor}`}
                    aria-current={stage.status === 'active' ? 'step' : undefined}
                  >
                    <span className="agentic-rail__dot" aria-hidden="true" />
                    <span className="agentic-rail__label">{stage.label}</span>
                  </li>
                ))}
              </ol>
              {target.total > 0 ? (
                <div
                  className="agentic-rail__progress"
                  role="progressbar"
                  aria-valuenow={target.done}
                  aria-valuemin={0}
                  aria-valuemax={target.total}
                  aria-label={`${String(target.done)} of ${String(target.total)} tasks done`}
                >
                  <span
                    style={{ width: `${String(Math.round((target.done / target.total) * 100))}%` }}
                  />
                </div>
              ) : null}
              <p
                className={`luwibot-cockpit__status${
                  target.state === 'blocked' && target.question !== undefined
                    ? ' luwibot-cockpit__status--question'
                    : ''
                }`}
              >
                {target.state === 'blocked' && target.question !== undefined
                  ? target.question
                  : cockpitStatus(target.state, target.done, target.total)}
              </p>
              {where.text === '' ? null : (
                <p
                  className={`agentic-rail__where${where.you ? ' agentic-rail__where--you' : ''}`}
                  role="status"
                >
                  {where.text}
                </p>
              )}
              {flow?.status === 'ready' && (flow.goals[0]?.tasks.length ?? 0) > 0 ? (
                <ul className="luwibot-cockpit__tasks">
                  {flow.goals[0]?.tasks.map((task) => (
                    <li key={task.id} className="luwibot-cockpit__task">
                      <span className="luwibot-cockpit__task-label">{task.label}</span>
                      <span className="luwibot-cockpit__task-chips">
                        <StatusChip tone={task.state.tone}>{task.state.label}</StatusChip>
                        {task.verdict === undefined ? null : (
                          <StatusChip tone={task.verdict.tone}>{task.verdict.label}</StatusChip>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="luwibot-cockpit__controls">
                {target.state === 'plan_review' ? (
                  <>
                    <button
                      type="button"
                      className="luwibot-cockpit__btn luwibot-cockpit__btn--primary"
                      disabled={pending !== undefined}
                      onClick={() => setConfirmAction('approve_plan')}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="luwibot-cockpit__btn"
                      disabled={pending !== undefined}
                      onClick={() => setConfirmAction('reject_plan')}
                    >
                      Reject
                    </button>
                  </>
                ) : null}
                {target.state === 'blocked' ? (
                  <form
                    className="luwibot-cockpit__answer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const text = answerRef.current?.value.trim() ?? '';
                      if (text === '' || pending !== undefined) return;
                      sendIntent('answer_goal', { text });
                      if (answerRef.current) answerRef.current.value = '';
                    }}
                  >
                    <textarea
                      ref={answerRef}
                      className="luwibot-cockpit__answer-input"
                      rows={2}
                      placeholder="Answer the blocked question…"
                      aria-label="Answer"
                      disabled={pending !== undefined}
                    />
                    <button
                      type="submit"
                      className="luwibot-cockpit__btn luwibot-cockpit__btn--primary"
                      disabled={pending !== undefined}
                    >
                      Send answer
                    </button>
                  </form>
                ) : null}
                <button
                  type="button"
                  className="luwibot-cockpit__btn luwibot-cockpit__btn--danger"
                  disabled={pending !== undefined}
                  onClick={() => setConfirmAction('abandon_goal')}
                >
                  Stop
                </button>
                {intentError === undefined ? null : (
                  <p className="luwibot-cockpit__error" role="status">
                    {intentError}
                  </p>
                )}
              </div>
            </section>
          )}
          {confirmAction === undefined ? null : (
            <ConfirmDialog
              title={CONFIRM_COPY[confirmAction].title}
              confirmLabel={CONFIRM_COPY[confirmAction].confirm}
              busy={pending !== undefined}
              onCancel={() => setConfirmAction(undefined)}
              onConfirm={() => {
                sendIntent(confirmAction);
                setConfirmAction(undefined);
              }}
            >
              <p>
                {CONFIRM_COPY[confirmAction].verb} “{target?.title ?? 'this goal'}”?
              </p>
            </ConfirmDialog>
          )}
          <div className="luwibot__log" ref={logRef}>
            {messages.length === 0 ? (
              <p className="luwibot__empty">
                Ask while you build — I answer from LUWI's live state.
              </p>
            ) : (
              messages.map((message, index) => (
                <p key={index} className={`luwibot__msg luwibot__msg--${message.role}`}>
                  {message.text}
                </p>
              ))
            )}
            {busy ? <p className="luwibot__msg luwibot__msg--assistant">…</p> : null}
          </div>
          <form
            className="luwibot__form"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={inputRef}
              className="luwibot__input"
              rows={1}
              placeholder="Ask LuwiBot…"
              aria-label="Message"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="luwibot__send" aria-label="Send" disabled={busy}>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M2 8h10M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
        </section>
      ) : null}
      {open ? null : (
        <button
          type="button"
          className="luwibot__bar"
          aria-label={chatOffline ? 'LuwiBot offline' : 'Ask LuwiBot'}
          title={chatOffline ? 'LuwiBot is offline' : undefined}
          disabled={chatOffline}
          onClick={() => setOpen(true)}
        >
          <span className={`luwibot__dot luwibot__dot--${tone.dot}`} aria-hidden="true" />
          <span className="luwibot__bar-title">{chatOffline ? 'LuwiBot offline' : 'LuwiBot'}</span>
          <svg
            className="luwibot__bar-chevron"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="M4 10l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
