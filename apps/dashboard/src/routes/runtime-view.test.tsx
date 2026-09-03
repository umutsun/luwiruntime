// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeResources } from '../api/runtime-resources.js';
import type { ResourceState } from '../components/panel.js';
import type { PulseSnapshot } from '../pulse/model.js';
import { RuntimeView } from './runtime-view.js';

afterEach(cleanup);

/** Only the two resources this view reads; the rest of the snapshot is irrelevant here. */
const snapshot = {
  health: { state: 'unavailable' },
  runtime: { state: 'unavailable' },
} as unknown as PulseSnapshot;

const figures: RuntimeResources = {
  observedAt: '2026-09-02T10:00:10.000Z',
  host: {
    platform: 'win32',
    cpu: { model: 'AMD Ryzen AI 9 HX 370', cores: 24, utilizationPercent: 17.4 },
    memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 12 * 1024 ** 3 },
    disk: { path: 'C:/Users/dev/.luwi', totalBytes: 2 * 1024 ** 4, freeBytes: 1.5 * 1024 ** 4 },
    gpus: [
      {
        name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
        memoryUsedBytes: 1024 ** 3,
        memoryTotalBytes: 8 * 1024 ** 3,
        utilizationPercent: 7,
      },
    ],
  },
  daemon: { pid: 4242, rssBytes: 64 * 1024 ** 2, heapUsedBytes: 20 * 1024 ** 2, cpuPercent: 0.4 },
  redis: { usedMemoryBytes: 284 * 1024 ** 2, maxMemoryBytes: 0, keyCount: 131_508 },
};

function loaderFor(result: ResourceState<RuntimeResources>) {
  return vi.fn(async (): Promise<ResourceState<RuntimeResources>> => result);
}

describe('RuntimeView resources', () => {
  it('shows nothing about the machine when no reader is bound', () => {
    render(<RuntimeView snapshot={snapshot} websocketState="live" />);

    expect(screen.queryByText('Host')).toBeNull();
    expect(screen.queryByText('Footprint')).toBeNull();
  });

  it('shows the machine and the footprint in the units the machine counts in', async () => {
    render(
      <RuntimeView
        snapshot={snapshot}
        websocketState="live"
        loadResources={loaderFor({ state: 'ready', data: figures })}
      />,
    );

    const host = await screen.findByRole('region', { name: /host/i });
    expect(within(host).getByText('AMD Ryzen AI 9 HX 370 · 24 cores')).toBeTruthy();
    expect(within(host).getByText('17%')).toBeTruthy();
    expect(within(host).getByText('52.0 GiB used of 64.0 GiB')).toBeTruthy();
    expect(within(host).getByText('1.5 TiB free of 2.0 TiB · C:/Users/dev/.luwi')).toBeTruthy();
    expect(
      within(host).getByText('NVIDIA GeForce RTX 4070 Laptop GPU · 1.0 GiB of 8.0 GiB · 7%'),
    ).toBeTruthy();

    const footprint = screen.getByRole('region', { name: /footprint/i });
    expect(within(footprint).getByText('64.0 MiB resident · 20.0 MiB heap')).toBeTruthy();
    expect(within(footprint).getByText('0%')).toBeTruthy();
    expect(within(footprint).getByText('284.0 MiB · no limit set')).toBeTruthy();
    expect(within(footprint).getByText((131_508).toLocaleString())).toBeTruthy();
  });

  it('says it is measuring on a first read and names what is not there', async () => {
    const first: RuntimeResources = {
      observedAt: figures.observedAt,
      host: {
        platform: 'linux',
        cpu: { cores: 4 },
        memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 },
      },
      daemon: { pid: 1, rssBytes: 1024, heapUsedBytes: 512 },
    };
    render(
      <RuntimeView
        snapshot={snapshot}
        websocketState="live"
        loadResources={loaderFor({ state: 'ready', data: first })}
      />,
    );

    const host = await screen.findByRole('region', { name: /host/i });
    expect(within(host).getByText('linux · 4 cores')).toBeTruthy();
    expect(within(host).getAllByText('Measuring…').length).toBeGreaterThan(0);
    expect(within(host).getByText('Not detected')).toBeTruthy();
    expect(within(host).getByText('Unavailable')).toBeTruthy();
    const footprint = screen.getByRole('region', { name: /footprint/i });
    expect(within(footprint).getAllByText('Unavailable')).toHaveLength(2);
  });

  it('reports a failed read as unavailable rather than as an empty machine', async () => {
    render(
      <RuntimeView
        snapshot={snapshot}
        websocketState="live"
        loadResources={loaderFor({ state: 'unavailable' })}
      />,
    );

    const host = await screen.findByRole('region', { name: /host/i });
    await waitFor(() => expect(within(host).getByText('Unavailable')).toBeTruthy());
  });
});
