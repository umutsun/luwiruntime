// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBuildWatch } from './use-build-watch.js';

afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
});

function Probe({ fetchImpl }: { fetchImpl: typeof fetch }) {
  const stale = useBuildWatch(fetchImpl);
  return <p>{stale ? 'stale' : 'current'}</p>;
}

const indexHtml = (bundle: string): string =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${bundle}"></script></head><body></body></html>`;

const serving = (bundle: string) =>
  vi.fn(
    async () =>
      new Response(indexHtml(bundle), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  ) as unknown as typeof fetch;

/** What a built page carries: the module script Vite wrote into index.html. */
function loadedBundle(bundle: string): void {
  const script = document.createElement('script');
  script.type = 'module';
  script.src = `/assets/${bundle}`;
  document.head.append(script);
}

describe('useBuildWatch', () => {
  it('reports a served build newer than the one this page is running', async () => {
    loadedBundle('index-AAAA.js');
    render(<Probe fetchImpl={serving('index-BBBB.js')} />);
    expect(await screen.findByText('stale')).toBeTruthy();
  });

  it('stays current while the served build is the running one', async () => {
    loadedBundle('index-AAAA.js');
    const fetchImpl = serving('index-AAAA.js');
    render(<Probe fetchImpl={fetchImpl} />);
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('current')).toBeTruthy();
  });

  it('never asks off a built page', () => {
    const fetchImpl = serving('index-BBBB.js');
    render(<Probe fetchImpl={fetchImpl} />);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByText('current')).toBeTruthy();
  });
});
