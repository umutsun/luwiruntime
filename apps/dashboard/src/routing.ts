/**
 * Hash routing for the dashboard shell.
 *
 * Phase 5B carried two routes and parsed them inline. Phase 5C adds a third
 * that can carry a project id, so parsing lives here and is tested directly.
 *
 * Parsing never throws. An unknown route, a malformed percent sequence, or an
 * over-long id degrades to the nearest safe route rather than failing, because
 * the hash is user-editable and a thrown parse would blank the shell.
 */

/** Matches `identifierSchema` in `@luwi/protocol`, which is `min(1).max(128)`. */
const MAX_PROJECT_ID_LENGTH = 128;

/**
 * Routes that carry no parameter. `projects` is handled separately because it
 * can carry a project id, and `pulse` is the fallback rather than a match.
 */
export const SIMPLE_ROUTES = [
  'activity',
  'sessions',
  'agents',
  'messages',
  'usage',
  'context',
  'optimization',
  'graph',
] as const;

type SimpleRouteName = (typeof SIMPLE_ROUTES)[number];

export type DashboardRoute =
  | { name: 'pulse' }
  | { name: SimpleRouteName }
  /**
   * `agentId` is only meaningful with a `projectId`: the reads it selects are
   * pair-scoped, so an agent without a project addresses nothing.
   */
  | { name: 'projects'; projectId?: string; agentId?: string };

export type DashboardRouteName = DashboardRoute['name'];

function isSimpleRoute(value: string | undefined): value is SimpleRouteName {
  return SIMPLE_ROUTES.includes(value as SimpleRouteName);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed percent sequence is literal text, not a parse failure. It
    // will simply not match a known project and render the not-found state.
    return segment;
  }
}

export function parseRoute(hash: string): DashboardRoute {
  const path = hash.startsWith('#') ? hash.slice(1) : '';
  const segments = path.split('/').filter((segment) => segment !== '');

  const [head, second] = segments;
  if (isSimpleRoute(head) && segments.length === 1) return { name: head };

  if (head === 'projects') {
    if (second === undefined) return { name: 'projects' };
    const projectId = decodeSegment(second).trim();
    if (projectId === '' || projectId.length > MAX_PROJECT_ID_LENGTH) {
      return { name: 'projects' };
    }
    // `projects/<id>/agents/<agentId>`. Anything else after the project id is
    // not a route this shell knows, and degrades to the project rather than
    // being rejected — the hash is user-editable.
    const [, , third, fourth] = segments;
    if (third === 'agents' && fourth !== undefined) {
      const agentId = decodeSegment(fourth).trim();
      if (agentId !== '' && agentId.length <= MAX_PROJECT_ID_LENGTH) {
        return { name: 'projects', projectId, agentId };
      }
    }
    return { name: 'projects', projectId };
  }

  return { name: 'pulse' };
}

export function routeHref(route: DashboardRoute): string {
  if (route.name === 'projects') {
    // Encoding keeps an id containing `/` from forging an extra path segment.
    if (route.projectId === undefined) return '#/projects';
    const base = `#/projects/${encodeURIComponent(route.projectId)}`;
    return route.agentId === undefined
      ? base
      : `${base}/agents/${encodeURIComponent(route.agentId)}`;
  }
  return `#/${route.name}`;
}
