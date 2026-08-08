import { createHash } from 'node:crypto';

export type FileIdentity = {
  id: string;
  projectId: string;
  relativePath: string;
};

export type ModuleRoot = {
  id: string;
  path: string;
};

function normalizeRelativePath(value: string): string {
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  if (
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error('The file path is outside the repository.');
  }
  return normalized;
}

export function createFileIdentity(projectId: string, relativePath: string): FileIdentity {
  const normalized = normalizeRelativePath(relativePath);
  return {
    id: `file-${createHash('sha256')
      .update(`${projectId}\0${normalized}`)
      .digest('hex')
      .slice(0, 32)}`,
    projectId,
    relativePath: normalized,
  };
}

export function mapFileToModule(
  relativePath: string,
  moduleRoots: readonly ModuleRoot[],
): ModuleRoot | null {
  const normalized = normalizeRelativePath(relativePath);
  const matches = moduleRoots
    .filter(({ path }) => {
      if (path === '.') return true;
      const root = normalizeRelativePath(path);
      return normalized === root || normalized.startsWith(`${root}/`);
    })
    .toSorted((left, right) => {
      const lengthDifference = right.path.length - left.path.length;
      return lengthDifference === 0 ? left.id.localeCompare(right.id) : lengthDifference;
    });
  return matches[0] ?? null;
}
