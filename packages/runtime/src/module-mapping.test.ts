import { describe, expect, it } from 'vitest';

import { createFileIdentity, mapFileToModule } from './module-mapping.js';

describe('deterministic file and module mapping', () => {
  const roots = [
    { id: 'root', path: '.' },
    { id: 'daemon', path: 'apps/daemon' },
    { id: 'protocol', path: 'packages/protocol' },
  ];

  it('uses normalized repository-relative file identities', () => {
    expect(createFileIdentity('project-1', '.\\apps\\daemon\\src\\app.ts')).toMatchObject({
      projectId: 'project-1',
      relativePath: 'apps/daemon/src/app.ts',
    });
  });

  it('selects the longest matching module root', () => {
    expect(mapFileToModule('apps/daemon/src/app.ts', roots)).toEqual({
      id: 'daemon',
      path: 'apps/daemon',
    });
    expect(mapFileToModule('README.md', roots)).toEqual({ id: 'root', path: '.' });
  });

  it('rejects paths that escape the repository', () => {
    expect(() => createFileIdentity('project-1', '../secret.txt')).toThrow(/outside/i);
  });
});
