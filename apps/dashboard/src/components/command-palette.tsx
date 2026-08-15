import { useEffect, useMemo, useRef, useState } from 'react';

import type { PulseSnapshot } from '../pulse/model.js';
import { routeHref, SIMPLE_ROUTES } from '../routing.js';

/**
 * The mockup's ⌘K search, kept navigate-only.
 *
 * The comp promised search over commits and files; no unified search endpoint
 * exists and files have no endpoint at all, so this palette searches exactly
 * what is already loaded — the route list and the snapshot's projects, agents
 * and sessions — and its only action is setting the location hash. It issues
 * no request and can never mutate; `product-independence.test.ts` would fail
 * the build if it tried.
 */

type PaletteEntry = { key: string; group: string; label: string; hint?: string; href: string };

const ROUTE_LABELS: Record<string, string> = {
  pulse: 'Pulse',
  activity: 'Activity',
  runtime: 'Runtime',
  projects: 'Projects',
  agents: 'Agents',
  sessions: 'Sessions',
  messages: 'Messages',
  capabilities: 'Capabilities',
  config: 'Configuration',
  usage: 'Usage',
  context: 'Context',
  optimization: 'Optimization',
  graph: 'Graph',
};

const MAX_RESULTS = 12;

function entriesOf(snapshot: PulseSnapshot): PaletteEntry[] {
  const routes: PaletteEntry[] = ['pulse' as const, ...SIMPLE_ROUTES, 'projects' as const].map(
    (name) => ({
      key: `route:${name}`,
      group: 'Route',
      label: ROUTE_LABELS[name] ?? name,
      href: `#/${name}`,
    }),
  );
  const projects: PaletteEntry[] = snapshot.projects.map((project) => ({
    key: `project:${project.id}`,
    group: 'Project',
    label: project.name,
    hint: project.localPath,
    href: routeHref({ name: 'projects', projectId: project.id }),
  }));
  const agents: PaletteEntry[] = snapshot.agents.map((agent) => ({
    key: `agent:${agent.id}`,
    group: 'Agent',
    label: agent.displayName,
    hint: agent.id,
    href: routeHref({ name: 'agents' }),
  }));
  const sessions: PaletteEntry[] = snapshot.sessions.map((session) => ({
    key: `session:${session.id}`,
    group: 'Session',
    label: `${session.agentName} · ${session.statusLabel}`,
    hint: session.id,
    href: routeHref({ name: 'sessions' }),
  }));
  return [...routes, ...projects, ...agents, ...sessions];
}

export function CommandPalette({
  snapshot,
  scopeSummary,
}: {
  snapshot: PulseSnapshot;
  scopeSummary: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => entriesOf(snapshot), [snapshot]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle === ''
        ? entries
        : entries.filter(
            (entry) =>
              entry.label.toLowerCase().includes(needle) ||
              (entry.hint?.toLowerCase().includes(needle) ?? false),
          ),
    [entries, needle],
  );
  const visible = matches.slice(0, MAX_RESULTS);
  const hidden = matches.length - visible.length;
  const selected = visible[Math.min(cursor, Math.max(0, visible.length - 1))];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setCursor(0);
    trigger.current?.focus();
  };
  const go = (entry: PaletteEntry | undefined) => {
    if (entry === undefined) return;
    window.location.hash = entry.href;
    close();
  };

  return (
    <>
      {/*
       * The trigger doubles as the scope line the command bar always had:
       * `aria-label="Current scope"` and its count text are pinned by
       * `app.test.tsx`, and a second search-shaped control beside it would
       * advertise the same thing twice.
       */}
      <button
        ref={trigger}
        type="button"
        className="command-shell command-shell--trigger"
        aria-label="Current scope"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M13 13l-2.7-2.7" strokeLinecap="round" />
        </svg>
        <span className="command-shell__scope">{scopeSummary}</span>
        <kbd className="command-shell__kbd">Ctrl K</kbd>
      </button>
      {open ? (
        <div
          className="palette-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          {/* Transient overlay, so aria-modal is truthful here — unlike the
              docked inspector, everything behind it really is inert while it
              is up, and Escape tears it down. */}
          <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
            <input
              ref={box}
              className="palette__input"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-results"
              aria-activedescendant={selected === undefined ? undefined : `palette-${selected.key}`}
              placeholder="Jump to a route, project, agent or session…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCursor((value) => (visible.length === 0 ? 0 : (value + 1) % visible.length));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCursor((value) =>
                    visible.length === 0 ? 0 : (value - 1 + visible.length) % visible.length,
                  );
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  go(selected);
                }
              }}
            />
            {visible.length === 0 ? (
              <p className="palette__empty">
                No matches in the loaded snapshot. The palette navigates over loaded evidence only —
                there is no server-side search.
              </p>
            ) : (
              <ul className="palette__results" id="palette-results" role="listbox">
                {visible.map((entry, index) => (
                  <li
                    key={entry.key}
                    id={`palette-${entry.key}`}
                    role="option"
                    aria-selected={entry.key === selected?.key}
                    className={`palette__option${
                      entry.key === selected?.key ? ' palette__option--active' : ''
                    }`}
                    onMouseEnter={() => setCursor(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      go(entry);
                    }}
                  >
                    <span className="palette__group">{entry.group}</span>
                    <span className="palette__label">{entry.label}</span>
                    {entry.hint === undefined ? null : (
                      <span className="palette__hint" title={entry.hint}>
                        {entry.hint}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {hidden > 0 ? (
              <p className="palette__more">{hidden} more — keep typing to narrow</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
