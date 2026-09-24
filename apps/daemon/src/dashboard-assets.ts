import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultDashboardDistRoot = fileURLToPath(
  new URL('../../dashboard/dist/', import.meta.url),
);

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export type DashboardAsset = {
  body: Buffer;
  contentType: string;
  immutable: boolean;
};

export async function readDashboardAsset(
  distRoot: string,
  requestPath: string,
): Promise<DashboardAsset | null> {
  let filePath: string;
  let contentType: string;
  let immutable: boolean;
  if (requestPath === '/') {
    filePath = join(distRoot, 'index.html');
    contentType = 'text/html; charset=utf-8';
    immutable = false;
  } else {
    const match = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(requestPath);
    if (match?.[1] === undefined) return null;
    const extension = /\.[^.]+$/.exec(match[1])?.[0]?.toLowerCase();
    if (extension === undefined || contentTypes[extension] === undefined) return null;
    filePath = join(distRoot, 'assets', match[1]);
    contentType = contentTypes[extension];
    immutable = true;
  }

  try {
    return { body: await readFile(filePath), contentType, immutable };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }
}
