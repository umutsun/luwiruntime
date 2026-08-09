import { describe, expect, it } from 'vitest';

import {
  affectsSelectedProject,
  needsIntelligenceOf,
  resourcesOf,
  seedActivity,
  selectedProjectOf,
} from './bootstrap.js';
import type { PulseInput } from './pulse/model.js';

/**
 * The composition root's policies, which nothing else in the app expresses.
 *
 * They lived inside `main.tsx` alongside `createRoot`, so importing them meant
 * mounting the application and no test could reach them. They are pure, and
 * each one decides something a user notices when it is wrong.
 */

const input = (overrides: Partial<PulseInput> = {}): PulseInput => ({
  measuredLatencyMs: 1,
  snapshotAt: '2026-08-09T00:00:00.000Z',
  health: { state: 'unavailable' },
  projects: { state: 'ready', data: [] },
  sessions: { state: 'ready', data: [] },
  agents: { state: 'ready', data: [] },
  usage: { state: 'ready', data: [] },
  context: { state: 'ready', data: [] },
  activity: { state: 'unavailable' },
  findings: { state: 'ready', data: [] },
  ...overrides,
});

describe('selectedProjectOf', () => {
  it('reads the project id only from the projects route', () => {
    expect(selectedProjectOf('#/projects/p1')).toBe('p1');
    expect(selectedProjectOf('#/projects')).toBeUndefined();
    expect(selectedProjectOf('#/sessions')).toBeUndefined();
  });

  it('returns nothing for a fragment that is not a route', () => {
    // The skip link's target used to arrive here and clear the selection.
    expect(selectedProjectOf('#main-content')).toBeUndefined();
  });
});

describe('needsIntelligenceOf', () => {
  it('opens the extra reads only on the three routes that consume them', () => {
    for (const route of ['#/context', '#/optimization', '#/graph']) {
      expect(needsIntelligenceOf(route), route).toBe(true);
    }
  });

  it('keeps them off every other route, because the graph summary is not cheap', () => {
    // ADR 0013 prices the summary at 56 Redis commands with no cache, which is
    // why the overview must not pay for it.
    for (const route of ['#/pulse', '#/activity', '#/projects', '#/sessions', '#/usage', '']) {
      expect(needsIntelligenceOf(route), route).toBe(false);
    }
  });
});

describe('affectsSelectedProject', () => {
  it('is false when no project is selected, whatever the event carries', () => {
    expect(affectsSelectedProject(undefined, 'p1')).toBe(false);
    expect(affectsSelectedProject(undefined, undefined)).toBe(false);
  });

  it('is true for an event on the selected project', () => {
    expect(affectsSelectedProject('p1', 'p1')).toBe(true);
  });

  it('is false for an event on another project, so it costs no request', () => {
    expect(affectsSelectedProject('p1', 'p2')).toBe(false);
  });

  it('is true for a project-less event, which may still change the panels', () => {
    expect(affectsSelectedProject('p1', undefined)).toBe(true);
  });
});

describe('seedActivity', () => {
  it('seeds nothing from an unavailable activity read', () => {
    expect(seedActivity(input()).events).toEqual([]);
  });

  it('folds a ready read into the activity state', () => {
    const state = seedActivity(
      input({
        activity: {
          state: 'ready',
          data: [
            {
              version: 1 as const,
              streamId: '1-0',
              id: 'e1',
              type: 'session.updated',
              occurredAt: '2026-08-09T00:00:00.000Z',
              workspaceId: 'local',
              payload: {},
            },
          ],
        },
      }),
    );

    expect(state.events.map((event) => event.streamId)).toEqual(['1-0']);
  });
});

describe('resourcesOf', () => {
  it('carries every resource the refresh controller tracks', () => {
    expect(Object.keys(resourcesOf(input())).sort()).toEqual([
      'activity',
      'agents',
      'context',
      'findings',
      'health',
      'projects',
      'sessions',
      'usage',
    ]);
  });
});
