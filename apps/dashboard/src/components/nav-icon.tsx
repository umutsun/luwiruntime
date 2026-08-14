import type { DashboardRouteName } from '../routing.js';

/**
 * One 16px glyph per navigation destination.
 *
 * Authored here rather than pulled from an icon package: the dashboard is a
 * loopback-only surface with no CDN, and a whole icon library for twelve glyphs
 * is bytes the build does not need. Every path uses `currentColor` so the rail's
 * active and collapsed states tint them without a second rule.
 *
 * They are decorative. Each nav item still carries its text label, and the
 * collapsed rail keeps that label in the accessibility tree, so these are
 * `aria-hidden` everywhere.
 */
const PATHS: Record<DashboardRouteName | 'runtime', string> = {
  // A pulse trace — the operational snapshot.
  pulse: 'M1.5 8h3l2-4.5L9 12l2-4h3.5',
  // The same trace, denser: a stream of events rather than one reading.
  activity: 'M2 8h2l1.5-3L7.5 11 9 6.5l1 3h4',
  // A folder.
  projects: 'M1.75 4.25h4l1.5 2h7v7.5h-12.5z',
  // A box, seen in isolation — a definition, not a running thing.
  agents: 'M8 1.75 14 5v6l-6 3.25L2 11V5z M2 5l6 3.25L14 5 M8 8.25v6',
  // A shell prompt.
  sessions: 'M2.5 4.5 6 8l-3.5 3.5 M8.5 12h5',
  // A message frame.
  messages: 'M2 3.5h12v8H8l-3.5 2.5V11.5H2z',
  // Stacked plates — packages and profiles layered by scope.
  capabilities:
    'M8 1.75 14.5 5 8 8.25 1.5 5z M1.5 8.5 8 11.75 14.5 8.5 M1.5 11.5 8 14.75 14.5 11.5',
  // Sliders: configuration is values on tracks, not a gear.
  config: 'M2 4.5h12 M2 8h12 M2 11.5h12 M5.5 3v3 M10.5 6.5v3 M6.5 10v3',
  // Bars of unequal height — measured quantities.
  usage: 'M2.5 13.5v-4 M6 13.5v-7 M9.5 13.5v-3 M13 13.5v-9',
  // A window with a filled header band: what is loaded into a context.
  context: 'M2 3h12v10H2z M2 6h12',
  // A spark — a proposal, not a certainty.
  optimization:
    'M8 2v3 M8 11v3 M2 8h3 M11 8h3 M4.5 4.5 6.5 6.5 M9.5 9.5l2 2 M11.5 4.5 9.5 6.5 M6.5 9.5l-2 2',
  // Three nodes and their edges.
  graph:
    'M4 4.5a1.75 1.75 0 1 0 0-.01 M12 6a1.75 1.75 0 1 0 0-.01 M7 12.5a1.75 1.75 0 1 0 0-.01 M5.5 5.5 10.5 5.75 M11.5 7.5 8 11 M5 6 6.5 11',
  // A heartbeat inside a rounded frame — the daemon itself.
  runtime: 'M2.25 3.5h11.5v9H2.25z M4.5 8h2l1-2 1.5 4 1-2h1.5',
};

export function NavIcon({ route }: { route: DashboardRouteName | 'runtime' }) {
  return (
    <svg
      className="nav-item__icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[route]} />
    </svg>
  );
}
