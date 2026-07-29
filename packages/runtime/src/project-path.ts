import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { ApplicationError } from './application-error.js';

export type CanonicalPath = {
  localPath: string;
  canonicalPath: string;
  identityPath: string;
  pathIdentityHash: string;
};

export type PathDependencies = {
  platform: NodeJS.Platform;
  resolve: (input: string) => string;
  realpath: (input: string) => Promise<string>;
  isDirectory: (input: string) => Promise<boolean>;
};

const defaultDependencies: PathDependencies = {
  platform: process.platform,
  resolve: (input) => path.resolve(input),
  realpath,
  isDirectory: async (input) => (await stat(input)).isDirectory(),
};

function normalizeDisplayPath(input: string, platform: NodeJS.Platform): string {
  let normalized = input.replaceAll('\\', '/');
  if (platform === 'win32' && /^[a-zA-Z]:/.test(normalized)) {
    normalized = `${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}`;
  }

  const isRoot = normalized === '/' || /^[A-Za-z]:\/$/.test(normalized);
  return isRoot ? normalized : normalized.replace(/\/+$/, '');
}

async function canonicalizePath(
  input: string,
  errorCode: 'PROJECT_PATH_INVALID' | 'SESSION_WORKING_DIRECTORY_INVALID',
  dependencies: PathDependencies,
): Promise<CanonicalPath> {
  try {
    const resolvedPath = dependencies.resolve(input.trim());
    if (!(await dependencies.isDirectory(resolvedPath))) {
      throw new Error('Path is not a directory');
    }

    const localPath = normalizeDisplayPath(resolvedPath, dependencies.platform);
    const canonicalPath = normalizeDisplayPath(
      await dependencies.realpath(resolvedPath),
      dependencies.platform,
    );
    const identityPath =
      dependencies.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;

    return {
      localPath,
      canonicalPath,
      identityPath,
      pathIdentityHash: createHash('sha256').update(identityPath).digest('hex'),
    };
  } catch {
    throw new ApplicationError(
      errorCode,
      errorCode === 'PROJECT_PATH_INVALID'
        ? 'The project path must be an existing directory.'
        : 'The session working directory must be an existing directory.',
      400,
    );
  }
}

export function canonicalizeProjectPath(
  input: string,
  dependencies: PathDependencies = defaultDependencies,
): Promise<CanonicalPath> {
  return canonicalizePath(input, 'PROJECT_PATH_INVALID', dependencies);
}

export function canonicalizeWorkingDirectory(
  input: string,
  dependencies: PathDependencies = defaultDependencies,
): Promise<CanonicalPath> {
  return canonicalizePath(input, 'SESSION_WORKING_DIRECTORY_INVALID', dependencies);
}
