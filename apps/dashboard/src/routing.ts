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

export type DashboardRoute =
  { name: 'pulse' } | { name: 'activity' } | { name: 'projects'; projectId?: string };

export type DashboardRouteName = DashboardRoute['name'];

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
  if (head === 'activity' && segments.length === 1) return { name: 'activity' };

  if (head === 'projects') {
    if (second === undefined) return { name: 'projects' };
    const projectId = decodeSegment(second).trim();
    if (projectId === '' || projectId.length > MAX_PROJECT_ID_LENGTH) {
      return { name: 'projects' };
    }
    return { name: 'projects', projectId };
  }

  return { name: 'pulse' };
}

export function routeHref(route: DashboardRoute): string {
  if (route.name === 'activity') return '#/activity';
  if (route.name === 'projects') {
    // Encoding keeps an id containing `/` from forging an extra path segment.
    return route.projectId === undefined
      ? '#/projects'
      : `#/projects/${encodeURIComponent(route.projectId)}`;
  }
  return '#/pulse';
}
