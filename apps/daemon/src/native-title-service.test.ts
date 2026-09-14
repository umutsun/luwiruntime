import { describe, expect, it, vi } from 'vitest';

import type { NativeSessionBinding, RuntimeStateName, SessionView } from '@luwi/protocol';

import {
  createNativeTitleService,
  createNativeTitleTick,
  type NativeTitleDependencies,
  type NativeTitleSource,
} from './native-title-service.js';

/** A title source: nativeSessionId → title, as the desktop or index store would answer. */
function source(titles: Record<string, string>): NativeTitleSource {
  return async (nativeSessionId) => titles[nativeSessionId];
}

function session(overrides: Partial<SessionView> & Pick<SessionView, 'id'>): SessionView {
  return {
    agentId: 'agent-1',
    projectId: 'project-1',
    status: 'idle',
    workingDirectory: 'C:/work',
    startedAt: '2026-09-14T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-14T00:00:00.000Z',
    metadata: {},
    presence: 'online',
    ...overrides,
  };
}

function claudeBinding(nativeSessionId: string): NativeSessionBinding {
  return {
    id: `binding-${nativeSessionId}`,
    adapterId: 'claude-code',
    nativeSessionId,
    kind: 'main',
    version: 1,
    linkCount: 1,
    trimmedLinkCount: 0,
    firstLinkedAt: '2026-09-14T00:00:00.000Z',
    lastLinkedAt: '2026-09-14T00:00:00.000Z',
  };
}

type Repo = NativeTitleDependencies['repository'];

function repo(
  sessions: SessionView[],
  bindings: Record<string, NativeSessionBinding | null>,
): Repo {
  return {
    listSessions: async () => sessions,
    getSessionNativeBindingId: async (id) =>
      bindings[id] === undefined ? null : (bindings[id]?.id ?? null),
    getNativeBinding: async (bindingId) =>
      Object.values(bindings).find((b) => b?.id === bindingId) ?? null,
  };
}

function makeDeps(
  over: Partial<NativeTitleDependencies> & Pick<NativeTitleDependencies, 'repository'>,
): NativeTitleDependencies {
  return {
    sources: {},
    setTitle: vi.fn(async () => undefined),
    ...over,
  };
}

describe('createNativeTitleService.resolveOnce', () => {
  it('writes the desktop title onto a live, untitled, claude-code main session', async () => {
    const s = session({ id: 's1' });
    const setTitle = vi.fn(async () => undefined);
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'cli-1': 'Build CB14' }) },
      repository: repo([s], { s1: claudeBinding('cli-1') }),
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(setTitle).toHaveBeenCalledWith('s1', { title: 'Build CB14' });
    expect(summary.titlesWritten).toBe(1);
  });

  it('routes each binding to the source of its own adapter', async () => {
    const claude = session({ id: 'cc' });
    const codex = session({ id: 'cx' });
    const codexBinding: NativeSessionBinding = {
      ...claudeBinding('thread-1'),
      id: 'binding-cx',
      adapterId: 'codex',
    };
    const claudeSource = vi.fn(source({ 'cli-1': 'Desktop chat' }));
    const codexSource = vi.fn(source({ 'thread-1': 'Proje görevlerini sürdür' }));
    const setTitle = vi.fn(async () => undefined);
    const deps = makeDeps({
      sources: { 'claude-code': claudeSource, codex: codexSource },
      repository: repo([claude, codex], { cc: claudeBinding('cli-1'), cx: codexBinding }),
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(claudeSource).toHaveBeenCalledWith('cli-1');
    expect(claudeSource).not.toHaveBeenCalledWith('thread-1');
    expect(codexSource).toHaveBeenCalledWith('thread-1');
    expect(codexSource).not.toHaveBeenCalledWith('cli-1');
    expect(setTitle).toHaveBeenCalledWith('cc', { title: 'Desktop chat' });
    expect(setTitle).toHaveBeenCalledWith('cx', { title: 'Proje görevlerini sürdür' });
    expect(summary.titlesWritten).toBe(2);
  });

  it('merges the title into existing metadata rather than clobbering it', async () => {
    const s = session({ id: 's1', metadata: { model: 'opus', bridge: 'native-headless' } });
    const setTitle = vi.fn(async () => undefined);
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'cli-1': 'Title' }) },
      repository: repo([s], { s1: claudeBinding('cli-1') }),
      setTitle,
    });
    await createNativeTitleService(deps).resolveOnce();
    expect(setTitle).toHaveBeenCalledWith('s1', {
      model: 'opus',
      bridge: 'native-headless',
      title: 'Title',
    });
  });

  it('skips a session that already has a title (never fights the client poller)', async () => {
    const s = session({ id: 's1', metadata: { title: 'Client-owned' } });
    const setTitle = vi.fn(async () => undefined);
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'cli-1': 'Server' }) },
      repository: repo([s], { s1: claudeBinding('cli-1') }),
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(setTitle).not.toHaveBeenCalled();
    expect(summary.skippedHasTitle).toBe(1);
  });

  it('skips offline or terminal sessions (never re-asserts liveness)', async () => {
    const offline = session({ id: 'off', presence: 'offline' });
    const terminal = session({ id: 'term', status: 'completed' });
    const setTitle = vi.fn(async () => undefined);
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'cli-1': 'T' }) },
      repository: repo([offline, terminal], {
        off: claudeBinding('cli-1'),
        term: claudeBinding('cli-1'),
      }),
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(setTitle).not.toHaveBeenCalled();
    expect(summary.skippedNotLive).toBe(2);
  });

  it('skips sessions with no binding, a sourceless adapter, or a subagent binding', async () => {
    const noBinding = session({ id: 'nb' });
    const gemini = session({ id: 'gm' });
    const sub = session({ id: 'su' });
    const subagent: NativeSessionBinding = { ...claudeBinding('cli-3'), kind: 'subagent' };
    const geminiBinding: NativeSessionBinding = {
      ...claudeBinding('cli-2'),
      id: 'binding-gm',
      adapterId: 'gemini',
    };
    const setTitle = vi.fn(async () => undefined);
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'cli-2': 'X', 'cli-3': 'Y' }) },
      repository: repo([noBinding, gemini, sub], {
        nb: null,
        gm: geminiBinding,
        su: subagent,
      }),
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(setTitle).not.toHaveBeenCalled();
    expect(summary.skippedNoBinding).toBe(1);
    expect(summary.skippedNoSource).toBe(2);
  });

  it('counts (does not throw) when the source has no title for the id', async () => {
    const s = session({ id: 's1' });
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'other-cli': 'Nope' }) },
      repository: repo([s], { s1: claudeBinding('cli-1') }),
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(summary.skippedNoTitleOnDisk).toBe(1);
    expect(summary.titlesWritten).toBe(0);
  });

  it('is a no-op when no source is configured', async () => {
    const s = session({ id: 's1' });
    const setTitle = vi.fn(async () => undefined);
    const listSessions = vi.fn(async () => [s]);
    const deps = makeDeps({
      sources: {},
      repository: { ...repo([s], { s1: claudeBinding('cli-1') }), listSessions },
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(listSessions).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
    expect(summary.sessionsScanned).toBe(0);
  });

  it('counts a write that races a close instead of aborting the scan', async () => {
    const s1 = session({ id: 's1' });
    const s2 = session({ id: 's2' });
    const setTitle = vi
      .fn<NativeTitleDependencies['setTitle']>()
      .mockRejectedValueOnce(new Error('SESSION_TERMINAL'))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({
      sources: { 'claude-code': source({ 'cli-1': 'A', 'cli-2': 'B' }) },
      repository: repo([s1, s2], { s1: claudeBinding('cli-1'), s2: claudeBinding('cli-2') }),
      setTitle,
    });
    const summary = await createNativeTitleService(deps).resolveOnce();
    expect(summary.writeErrors).toBe(1);
    expect(summary.titlesWritten).toBe(1);
  });
});

describe('createNativeTitleTick', () => {
  const ready = (): RuntimeStateName => 'ready';

  it('refuses to overlap and refuses work outside ready state', async () => {
    let running = false;
    const schedule = (work: () => Promise<void>): boolean => {
      running = true;
      void work().finally(() => {
        running = false;
      });
      return true;
    };
    const resolveOnce = vi.fn(async () => {
      // stays "in flight" long enough to prove overlap refusal
      await new Promise((r) => setTimeout(r, 5));
      return {} as never;
    });

    // Not ready → no work scheduled.
    const notReadyTick = createNativeTitleTick({
      runtimeState: () => 'starting' as RuntimeStateName,
      schedule,
      resolveOnce,
      onComplete: () => undefined,
      onError: () => undefined,
    });
    notReadyTick();
    expect(resolveOnce).not.toHaveBeenCalled();

    // Ready → first tick runs; a second tick during flight is refused.
    const tick = createNativeTitleTick({
      runtimeState: ready,
      schedule,
      resolveOnce,
      onComplete: () => undefined,
      onError: () => undefined,
    });
    tick();
    tick();
    expect(resolveOnce).toHaveBeenCalledTimes(1);
    expect(running).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
  });
});
