// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Bounded, ContextSource, OptimizationProposal } from '../api/intelligence-scope.js';
import { buildPulseSnapshot, type PulseFinding, type PulseInput } from '../pulse/model.js';
import { ContextView } from './context-view.js';
import { OptimizationView } from './optimization-view.js';

afterEach(cleanup);

function baseInput(overrides: Partial<PulseInput> = {}): PulseInput {
  return {
    measuredLatencyMs: 5,
    snapshotAt: '2026-08-08T00:00:00.000Z',
    health: { state: 'unavailable' },
    projects: { state: 'ready', data: [] },
    sessions: { state: 'ready', data: [] },
    agents: { state: 'ready', data: [] },
    usage: { state: 'unavailable' },
    context: { state: 'ready', data: [] },
    activity: { state: 'unavailable' },
    findings: { state: 'ready', data: [] },
    ...overrides,
  };
}

const sources: Bounded<ContextSource> = {
  truncated: false,
  items: [
    {
      id: 'src-1',
      sourceType: 'instruction',
      path: 'C:/work/alpha/AGENTS.md',
      loadingScope: 'project',
      loadingMode: 'automatic',
      byteCount: 1200,
      lineCount: 40,
      estimatedTokenCount: 300,
      estimationMethod: 'generic-character-estimate',
    },
  ],
};

describe('ContextView', () => {
  it('renders the observation states as independent counts including unknown', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        context: {
          state: 'ready',
          data: [
            { assigned: true, effective: true, loaded: true, invoked: false },
            { assigned: true, effective: 'unknown', loaded: false, invoked: false },
          ],
        },
      }),
    );
    render(<ContextView snapshot={snapshot} sources={sources} />);

    for (const label of ['Assigned', 'Effective', 'Loaded', 'Invoked', 'Unknown']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('states that the observations are not pipeline stages', () => {
    render(<ContextView snapshot={buildPulseSnapshot(baseInput())} sources={sources} />);

    expect(screen.getByText(/not stages of one pipeline/i)).toBeTruthy();
  });

  it('labels token figures as estimates rather than measurements', () => {
    render(<ContextView snapshot={buildPulseSnapshot(baseInput())} sources={sources} />);

    const panel = screen.getByRole('region', { name: /context sources/i });
    expect(within(panel).getByText(/generic character estimates/i)).toBeTruthy();
  });

  it('reports unavailable context observations rather than showing zeroes', () => {
    render(
      <ContextView
        snapshot={buildPulseSnapshot(baseInput({ context: { state: 'unavailable' } }))}
        sources={sources}
      />,
    );

    const panel = screen.getByRole('region', { name: /context observations/i });
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
  });

  it('keeps an unloaded source list unavailable and an empty one empty', () => {
    const snapshot = buildPulseSnapshot(baseInput());
    const { unmount } = render(<ContextView snapshot={snapshot} sources={undefined} />);
    expect(
      within(screen.getByRole('region', { name: /context sources/i })).getByText('Unavailable'),
    ).toBeTruthy();
    unmount();

    render(<ContextView snapshot={snapshot} sources={{ truncated: false, items: [] }} />);
    expect(screen.getByText(/no context sources detected/i)).toBeTruthy();
  });

  it('reports a read still in flight as loading rather than as a fault', () => {
    // The first paint of this route has no intelligence resources yet. Calling
    // that "Unavailable" asserted a failure that had not happened.
    render(<ContextView snapshot={buildPulseSnapshot(baseInput())} sources={undefined} loading />);

    const panel = screen.getByRole('region', { name: /context sources/i });
    expect(within(panel).getByText(/loading/i)).toBeTruthy();
    expect(within(panel).queryByText('Unavailable')).toBeNull();
  });

  it('discloses truncation of the bounded source list', () => {
    render(
      <ContextView
        snapshot={buildPulseSnapshot(baseInput())}
        sources={{ ...sources, truncated: true }}
      />,
    );

    expect(screen.getByText(/more context sources exist/i)).toBeTruthy();
  });
});

const finding = (over: Partial<PulseFinding> = {}): PulseFinding => ({
  id: 'f1',
  projectId: 'p1',
  kind: 'exact-duplicate-content',
  title: 'Duplicate instruction content',
  summary: 'Two sources share identical content.',
  state: 'open',
  confidence: 'high',
  sessionCount: 4,
  observationCount: 12,
  updatedAt: '2026-08-08T00:00:00.000Z',
  ...over,
});

const proposals: Bounded<OptimizationProposal> = {
  truncated: false,
  items: [
    {
      id: 'pr-1',
      projectId: 'p1',
      title: 'De-scope an unused source',
      summary: 'Never observed loaded.',
      state: 'proposed',
      confidence: 'medium',
      findingCount: 2,
      actionCount: 1,
      estimatedSavingTokens: 900,
      sessionCount: 5,
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
    {
      id: 'pr-2',
      projectId: 'p1',
      title: 'Unestimated proposal',
      summary: 'No saving estimate.',
      state: 'accepted',
      confidence: 'low',
      findingCount: 1,
      actionCount: 1,
      sessionCount: 3,
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
  ],
};

describe('OptimizationView', () => {
  it('renders every finding state and confidence tier as text', () => {
    const snapshot = buildPulseSnapshot(
      baseInput({
        findings: {
          state: 'ready',
          data: [
            finding({ id: 'f1', state: 'open', confidence: 'high' }),
            finding({ id: 'f2', state: 'dismissed', confidence: 'medium' }),
            finding({ id: 'f3', state: 'proposed', confidence: 'low' }),
            finding({ id: 'f4', state: 'resolved', confidence: 'unknown' }),
          ],
        },
      }),
    );
    render(<OptimizationView snapshot={snapshot} proposals={proposals} />);

    const panel = screen.getByRole('region', { name: /findings/i });
    for (const state of ['open', 'dismissed', 'proposed', 'resolved']) {
      expect(within(panel).getByText(state)).toBeTruthy();
    }
    for (const tier of ['High', 'Medium', 'Low', 'Unknown']) {
      expect(within(panel).getByText(tier)).toBeTruthy();
    }
  });

  it('renders an unestimated saving as not estimated rather than zero', () => {
    render(<OptimizationView snapshot={buildPulseSnapshot(baseInput())} proposals={proposals} />);

    const row = screen.getByRole('row', { name: /Unestimated proposal/ });
    expect(within(row).getByText('Not estimated')).toBeTruthy();
    expect(within(row).queryByText('0')).toBeNull();
  });

  it('renders no accept, reject, evaluate, or analyze control', () => {
    render(<OptimizationView snapshot={buildPulseSnapshot(baseInput())} proposals={proposals} />);

    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/accept|reject|evaluate|analyz|apply/i);
    }
    expect(screen.getByText(/never exposed on a read surface/i)).toBeTruthy();
  });

  it('keeps findings empty and unavailable distinct', () => {
    const { unmount } = render(
      <OptimizationView snapshot={buildPulseSnapshot(baseInput())} proposals={proposals} />,
    );
    expect(screen.getByText(/no structural findings recorded/i)).toBeTruthy();
    unmount();

    render(
      <OptimizationView
        snapshot={buildPulseSnapshot(baseInput({ findings: { state: 'unavailable' } }))}
        proposals={proposals}
      />,
    );
    expect(
      within(screen.getByRole('region', { name: /findings/i })).getByText('Unavailable'),
    ).toBeTruthy();
  });

  it('discloses truncation of the bounded proposal list', () => {
    render(
      <OptimizationView
        snapshot={buildPulseSnapshot(baseInput())}
        proposals={{ ...proposals, truncated: true }}
      />,
    );

    expect(screen.getByText(/more proposals exist/i)).toBeTruthy();
  });

  it('does not claim truncation when the list is complete', () => {
    render(<OptimizationView snapshot={buildPulseSnapshot(baseInput())} proposals={proposals} />);

    expect(screen.queryByText(/more proposals exist/i)).toBeNull();
  });
});
