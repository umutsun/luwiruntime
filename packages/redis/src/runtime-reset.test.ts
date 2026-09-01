import { describe, expect, it, vi } from 'vitest';

import type { RedisCommandClient } from './runtime-repository.js';
import {
  inspectRuntimeNamespace,
  resetRuntimeNamespace,
  type RuntimeResetPartialError,
} from './runtime-reset.js';

function clientWithReplies(replies: unknown[]): {
  client: RedisCommandClient;
  sendCommand: ReturnType<typeof vi.fn>;
} {
  const queue = [...replies];
  const sendCommand = vi.fn(async () => queue.shift());
  return { client: { sendCommand }, sendCommand };
}

describe('Redis runtime namespace reset', () => {
  it('inspects every SCAN page with the exact bounded namespace pattern', async () => {
    const { client, sendCommand } = clientWithReplies([
      ['7', ['luwi:v1:project:1', 'luwi:v1:events:global']],
      ['0', ['luwi:v1:project:1', 'luwi:v1:index:projects']],
    ]);

    await expect(inspectRuntimeNamespace(client, { namespace: 'luwi:v1:' })).resolves.toEqual({
      namespace: 'luwi:v1:',
      matched: 3,
    });
    expect(sendCommand).toHaveBeenNthCalledWith(1, [
      'SCAN',
      '0',
      'MATCH',
      'luwi:v1:*',
      'COUNT',
      '500',
    ]);
    expect(sendCommand).toHaveBeenNthCalledWith(2, [
      'SCAN',
      '7',
      'MATCH',
      'luwi:v1:*',
      'COUNT',
      '500',
    ]);
  });

  it('fails closed when Redis returns a key outside the requested namespace', async () => {
    const { client } = clientWithReplies([['0', ['other-app:important']]]);

    await expect(inspectRuntimeNamespace(client, { namespace: 'luwi:v1:' })).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });

  it('fails closed on malformed or cycling SCAN cursors', async () => {
    const malformed = clientWithReplies([['not-a-cursor', []]]);
    await expect(
      inspectRuntimeNamespace(malformed.client, { namespace: 'luwi:v1:' }),
    ).rejects.toMatchObject({ code: 'REDIS_DATA_INVALID' });

    const cycling = clientWithReplies([
      ['7', ['luwi:v1:first']],
      ['7', ['luwi:v1:second']],
    ]);
    await expect(
      inspectRuntimeNamespace(cycling.client, { namespace: 'luwi:v1:' }),
    ).rejects.toMatchObject({ code: 'REDIS_DATA_INVALID' });
    expect(cycling.sendCommand).toHaveBeenCalledTimes(2);
  });

  it('rejects deletion batch options above the hard safety limit', async () => {
    const { client, sendCommand } = clientWithReplies([['0', ['luwi:v1:item:1']]]);

    await expect(
      resetRuntimeNamespace(client, { namespace: 'luwi:v1:', batchSize: 101 }),
    ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('deletes only validated keys in bounded UNLINK batches', async () => {
    const keys = Array.from({ length: 205 }, (_, index) => `luwi:v1:item:${index}`);
    const sortedKeys = [...keys].sort();
    const { client, sendCommand } = clientWithReplies([['0', keys], 100, 100, 5]);

    await expect(resetRuntimeNamespace(client, { namespace: 'luwi:v1:' })).resolves.toEqual({
      namespace: 'luwi:v1:',
      matched: 205,
      deleted: 205,
      status: 'reset',
    });
    expect(sendCommand).toHaveBeenNthCalledWith(2, ['UNLINK', ...sortedKeys.slice(0, 100)]);
    expect(sendCommand).toHaveBeenNthCalledWith(3, ['UNLINK', ...sortedKeys.slice(100, 200)]);
    expect(sendCommand).toHaveBeenNthCalledWith(4, ['UNLINK', ...sortedKeys.slice(200)]);
    expect(sendCommand.mock.calls.flat(2)).not.toContain('FLUSHDB');
    expect(sendCommand.mock.calls.flat(2)).not.toContain('FLUSHALL');
    expect(sendCommand.mock.calls.flat(2)).not.toContain('KEYS');
  });

  it('reports an empty namespace without issuing a deletion command', async () => {
    const { client, sendCommand } = clientWithReplies([['0', []]]);

    await expect(resetRuntimeNamespace(client, { namespace: 'luwi:v1:' })).resolves.toEqual({
      namespace: 'luwi:v1:',
      matched: 0,
      deleted: 0,
      status: 'empty',
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('reports completed deletion evidence when a later batch fails', async () => {
    const keys = Array.from({ length: 101 }, (_, index) => `luwi:v1:item:${index}`);
    const failure = new Error('connection lost');
    const sendCommand = vi
      .fn()
      .mockResolvedValueOnce(['0', keys])
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(failure);

    await expect(resetRuntimeNamespace({ sendCommand }, { namespace: 'luwi:v1:' })).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeResetPartialError>>({
        code: 'RUNTIME_RESET_PARTIAL',
        matched: 101,
        deleted: 100,
      }),
    );
  });
});
