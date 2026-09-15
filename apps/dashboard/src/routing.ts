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

/** Matches bounded identifiers in `@luwi/protocol`, which are `min(1).max(128)`. */
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Routes that carry no parameter. `projects` and `messages` are handled
 * separately because they can carry bounded identifiers, and `pulse` is the
 * fallback rather than a match.
 */
export const SIMPLE_ROUTES = [
  'activity',
  'runtime',
  'sessions',
  'agents',
  'capabilities',
  'config',
  'usage',
  'context',
  'optimization',
  'graph',
] as const;

type SimpleRouteName = (typeof SIMPLE_ROUTES)[number];

export type DashboardRoute =
  /**
   * The overview, optionally focused on one project. The focus rides in the
   * hash so a reload, a link and the back link from a detail route return to
   * the same project; session and agent focus stay transient.
   */
  | {
      name: 'pulse';
      projectId?: string;
      /**
       * `#/pulse/<id>/detail[/<agentId>]`: the project's detail drawer, open
       * over the overview. It is in the hash for the same reason the focus is
       * — the scoped reads load for it and a reload reopens it — and so that
       * opening it never leaves the overview for the registry route.
       */
      detail?: { agentId?: string };
    }
  | { name: SimpleRouteName }
  | { name: 'messages'; correlationId?: string }
  | { name: 'knowledge'; projectId?: string }
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

  if (head === 'messages') {
    if (second === undefined) return { name: 'messages' };
    const correlationId = decodeSegment(second).trim();
    return segments.length === 2 &&
      correlationId !== '' &&
      correlationId.length <= MAX_IDENTIFIER_LENGTH
      ? { name: 'messages', correlationId }
      : { name: 'messages' };
  }

  if (head === 'projects') {
    if (second === undefined) return { name: 'projects' };
    const projectId = decodeSegment(second).trim();
    if (projectId === '' || projectId.length > MAX_IDENTIFIER_LENGTH) {
      return { name: 'projects' };
    }
    // `projects/<id>/agents/<agentId>`. Anything else after the project id is
    // not a route this shell knows, and degrades to the project rather than
    // being rejected — the hash is user-editable.
    const [, , third, fourth] = segments;
    if (third === 'agents' && fourth !== undefined) {
      const agentId = decodeSegment(fourth).trim();
      if (agentId !== '' && agentId.length <= MAX_IDENTIFIER_LENGTH) {
        return { name: 'projects', projectId, agentId };
      }
    }
    return { name: 'projects', projectId };
  }

  if (head === 'pulse' && second !== undefined) {
    const projectId = decodeSegment(second).trim();
    if (projectId !== '' && projectId.length <= MAX_IDENTIFIER_LENGTH) {
      const [, , third, fourth] = segments;
      if (third !== 'detail') return { name: 'pulse', projectId };
      const agentId = fourth === undefined ? '' : decodeSegment(fourth).trim();
      return {
        name: 'pulse',
        projectId,
        detail: agentId !== '' && agentId.length <= MAX_IDENTIFIER_LENGTH ? { agentId } : {},
      };
    }
  }

  if (head === 'knowledge') {
    if (second === undefined) return { name: 'knowledge' };
    const projectId = decodeSegment(second).trim();
    return projectId !== '' && projectId.length <= MAX_IDENTIFIER_LENGTH
      ? { name: 'knowledge', projectId }
      : { name: 'knowledge' };
  }

  return { name: 'pulse' };
}

export function routeHref(route: DashboardRoute): string {
  if (route.name === 'pulse') {
    if (route.projectId === undefined) return '#/pulse';
    const base = `#/pulse/${encodeURIComponent(route.projectId)}`;
    if (route.detail === undefined) return base;
    return route.detail.agentId === undefined
      ? `${base}/detail`
      : `${base}/detail/${encodeURIComponent(route.detail.agentId)}`;
  }
  if (route.name === 'messages') {
    return route.correlationId === undefined
      ? '#/messages'
      : `#/messages/${encodeURIComponent(route.correlationId)}`;
  }
  if (route.name === 'projects') {
    // Encoding keeps an id containing `/` from forging an extra path segment.
    if (route.projectId === undefined) return '#/projects';
    const base = `#/projects/${encodeURIComponent(route.projectId)}`;
    return route.agentId === undefined
      ? base
      : `${base}/agents/${encodeURIComponent(route.agentId)}`;
  }
  if (route.name === 'knowledge') {
    return route.projectId === undefined
      ? '#/knowledge'
      : `#/knowledge/${encodeURIComponent(route.projectId)}`;
  }
  return `#/${route.name}`;
}
