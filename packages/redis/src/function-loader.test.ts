import { describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  verifyOrLoadFunctionLibrary,
  type RedisAdminClient,
} from './index.js';

type LibraryState = {
  source: string;
  functionNames: string[];
};

class FakeAdminClient implements RedisAdminClient {
  readonly commands: string[][] = [];
  redisVersion = '7.2.5';
  library?: LibraryState;

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    const command = [...arguments_];
    this.commands.push(command);

    if (command[0] === 'INFO') {
      return `# Server\r\nredis_version:${this.redisVersion}\r\n`;
    }
    if (command[0] === 'FUNCTION' && command[1] === 'LIST') {
      if (this.library === undefined) {
        return [];
      }
      return [
        [
          'library_name',
          command[3],
          'engine',
          'LUA',
          'functions',
          this.library.functionNames.map((name) => [
            'name',
            name,
            'description',
            null,
            'flags',
            [],
          ]),
          'library_code',
          this.library.source,
        ],
      ];
    }
    if (command[0] === 'FUNCTION' && command[1] === 'LOAD') {
      const source = command.at(-1) ?? '';
      const functionNames = [...source.matchAll(/function_name='([^']+)'/g)].map(
        (match) => match[1] ?? '',
      );
      this.library = {
        source,
        functionNames,
      };
      return command.includes('REPLACE') ? 'REPLACED' : 'LOADED';
    }
    if (command[0] === 'FCALL') {
      return JSON.stringify({
        version: 1,
        libraryName: command[1]?.includes('test') ? 'test' : 'luwi_v1',
      });
    }
    throw new Error(`Unexpected command: ${command.join(' ')}`);
  }
}

describe('Redis Function loader', () => {
  it('rejects Redis versions older than 7.0', async () => {
    const client = new FakeAdminClient();
    client.redisVersion = '6.2.14';

    await expect(
      verifyOrLoadFunctionLibrary(client, buildFunctionLibrary(createFunctionRegistry()), {
        ownsLease: async () => true,
      }),
    ).rejects.toMatchObject({
      code: 'REDIS_VERSION_UNSUPPORTED',
      details: {
        detectedVersion: '6.2.14',
        requiredVersion: '7.0.0',
      },
    });
  });

  it('loads a missing library without REPLACE and verifies it', async () => {
    const client = new FakeAdminClient();
    const library = buildFunctionLibrary(createFunctionRegistry());

    await verifyOrLoadFunctionLibrary(client, library, {
      ownsLease: async () => true,
    });

    const load = client.commands.find(
      (command) => command[0] === 'FUNCTION' && command[1] === 'LOAD',
    );
    expect(load).toEqual(['FUNCTION', 'LOAD', library.source]);
    expect(client.commands.at(-1)?.[0]).toBe('FCALL');
  });

  it('preserves an already compatible library', async () => {
    const client = new FakeAdminClient();
    const library = buildFunctionLibrary(createFunctionRegistry());
    client.library = {
      source: library.source,
      functionNames: Object.values(library.registry.functions),
    };

    await verifyOrLoadFunctionLibrary(client, library, {
      ownsLease: async () => true,
    });

    expect(client.commands.some((command) => command[1] === 'LOAD')).toBe(false);
  });

  it('replaces an incompatible library only while ownership is valid', async () => {
    const client = new FakeAdminClient();
    const library = buildFunctionLibrary(createFunctionRegistry());
    client.library = {
      source: '#!lua name=luwi_v1\nredis.register_function("old", function() return 1 end)',
      functionNames: ['old'],
    };

    await verifyOrLoadFunctionLibrary(client, library, {
      ownsLease: async () => true,
    });

    expect(client.commands).toContainEqual(['FUNCTION', 'LOAD', 'REPLACE', library.source]);
  });

  it('refuses incompatible replacement without ownership', async () => {
    const client = new FakeAdminClient();
    const library = buildFunctionLibrary(createFunctionRegistry());
    client.library = {
      source: '#!lua name=luwi_v1\nredis.register_function("old", function() return 1 end)',
      functionNames: ['old'],
    };

    await expect(
      verifyOrLoadFunctionLibrary(client, library, {
        ownsLease: async () => false,
      }),
    ).rejects.toMatchObject({
      code: 'FUNCTION_LIBRARY_OWNERSHIP_REQUIRED',
    });
    expect(client.commands.some((command) => command[1] === 'LOAD')).toBe(false);
  });
});
