import type { Project } from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import { readdir, realpath } from 'node:fs/promises';
import * as nodePath from 'node:path';

export type ProjectDiscoveryEntry = {
  name: string;
  isDirectory: boolean;
};

export interface ProjectDiscoveryFileSystem {
  canonicalize(path: string): Promise<string>;
  listDirectory(path: string): Promise<ProjectDiscoveryEntry[]>;
}

export type ProjectCandidate = {
  directoryName: string;
  displayName: string;
  localPath: string;
  canonicalPath: string;
  existingProjectId?: string;
  reason?: string;
};

export type ProjectDiscoveryPlan = {
  root: string;
  selected: ProjectCandidate[];
  excluded: ProjectCandidate[];
  invalid: ProjectCandidate[];
};

export type ProjectDiscoveryService = {
  createPlan(input: {
    root: string;
    excludes: readonly string[];
    names: Readonly<Record<string, string>>;
    existingProjects: readonly Project[];
  }): Promise<ProjectDiscoveryPlan>;
};

type PathApi = Pick<typeof nodePath, 'isAbsolute' | 'join' | 'normalize' | 'relative' | 'resolve'>;

export type ProjectDiscoveryServiceOptions = {
  platform?: NodeJS.Platform;
  pathApi?: PathApi;
  fileSystem?: ProjectDiscoveryFileSystem;
};

const defaultFileSystem: ProjectDiscoveryFileSystem = {
  canonicalize: realpath,
  listDirectory: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
};

function optionKey(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function validBasename(value: string): boolean {
  const invalidCharacters = ['\\', '/', '\0', '*', '?', '[', ']', '{', '}'];
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !invalidCharacters.some((character) => value.includes(character)) &&
    value !== '.' &&
    value !== '..'
  );
}

function validateOptions(
  excludes: readonly string[],
  names: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): { exclusions: Set<string>; displayNames: Map<string, string> } {
  const exclusions = new Set<string>();
  for (const value of excludes) {
    if (!validBasename(value)) {
      throw new ApplicationError(
        'PROJECT_DISCOVERY_OPTION_INVALID',
        'Project discovery exclusions must be exact directory basenames.',
        400,
      );
    }
    const key = optionKey(value, platform);
    if (exclusions.has(key)) {
      throw new ApplicationError(
        'PROJECT_DISCOVERY_OPTION_INVALID',
        'Project discovery exclusions must be unique.',
        400,
      );
    }
    exclusions.add(key);
  }
  const displayNames = new Map<string, string>();
  for (const [directory, displayName] of Object.entries(names)) {
    if (!validBasename(directory) || displayName.trim() === '' || displayName.length > 200) {
      throw new ApplicationError(
        'PROJECT_DISCOVERY_OPTION_INVALID',
        'Project discovery name overrides are invalid.',
        400,
      );
    }
    const key = optionKey(directory, platform);
    if (displayNames.has(key)) {
      throw new ApplicationError(
        'PROJECT_DISCOVERY_OPTION_INVALID',
        'Project discovery name overrides must be unique.',
        400,
      );
    }
    displayNames.set(key, displayName.trim());
  }
  return { exclusions, displayNames };
}

export function createProjectDiscoveryService(
  options: ProjectDiscoveryServiceOptions = {},
): ProjectDiscoveryService {
  const platform = options.platform ?? process.platform;
  const pathApi = options.pathApi ?? nodePath;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const pathKey = (value: string): string =>
    platform === 'win32' ? pathApi.normalize(value).toLowerCase() : pathApi.normalize(value);
  return {
    async createPlan(input) {
      if (!pathApi.isAbsolute(input.root)) {
        throw new ApplicationError(
          'PROJECT_DISCOVERY_ROOT_INVALID',
          'The project discovery root must be absolute.',
          400,
        );
      }
      const { exclusions, displayNames } = validateOptions(input.excludes, input.names, platform);
      const root = await fileSystem.canonicalize(input.root);
      const existingByPath = new Map(
        input.existingProjects.map((project) => [pathKey(project.canonicalPath), project]),
      );
      const selected: ProjectCandidate[] = [];
      const excluded: ProjectCandidate[] = [];
      const invalid: ProjectCandidate[] = [];
      const entries = (await fileSystem.listDirectory(root))
        .filter(({ isDirectory }) => isDirectory)
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const localPath = pathApi.join(root, entry.name);
        const key = optionKey(entry.name, platform);
        if (exclusions.has(key)) {
          excluded.push({
            directoryName: entry.name,
            displayName: displayNames.get(key) ?? entry.name,
            localPath,
            canonicalPath: localPath,
            reason: 'excluded',
          });
          continue;
        }
        let canonicalPath: string;
        try {
          canonicalPath = await fileSystem.canonicalize(localPath);
        } catch {
          invalid.push({
            directoryName: entry.name,
            displayName: displayNames.get(key) ?? entry.name,
            localPath,
            canonicalPath: localPath,
            reason: 'unreadable',
          });
          continue;
        }
        const relative = pathApi.relative(root, canonicalPath);
        if (relative.startsWith('..') || pathApi.isAbsolute(relative)) {
          invalid.push({
            directoryName: entry.name,
            displayName: displayNames.get(key) ?? entry.name,
            localPath,
            canonicalPath,
            reason: 'outside_root',
          });
          continue;
        }
        const existing = existingByPath.get(pathKey(canonicalPath));
        selected.push({
          directoryName: entry.name,
          displayName: displayNames.get(key) ?? existing?.name ?? entry.name,
          localPath,
          canonicalPath,
          ...(existing === undefined ? {} : { existingProjectId: existing.id }),
        });
      }
      return { root, selected, excluded, invalid };
    },
  };
}
