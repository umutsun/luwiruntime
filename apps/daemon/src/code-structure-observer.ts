import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

/**
 * The code-structure observer from ADR 0012, first increment.
 *
 * It parses; it never executes. `ts.createSourceFile` builds a syntax tree
 * without running the module, and `ts.resolveModuleName` performs the same
 * lookup the compiler would without loading anything. No program, no type
 * checker, and no `require` of observed code.
 *
 * Records hold paths, symbol names, and locations only. Source text never
 * leaves this module, which is asserted by a test rather than left to review.
 */

const MAX_SCAN_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.pnpm-store',
]);

export class CodeStructureError extends Error {
  constructor(
    readonly code: 'CODE_STRUCTURE_SCAN_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CodeStructureError';
  }
}

/**
 * `toPath` is absent exactly when the target could not be named. ADR 0012
 * forbids rewriting that into the nearest plausible file, so the absence is
 * the answer and `confidence` is `unknown`.
 */
export type StructuralImport = {
  fromPath: string;
  toPath?: string;
  specifier: string;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  dynamic: boolean;
  line: number;
};

export type StructuralExport = {
  path: string;
  symbol: string;
  line: number;
};

export type CodeStructureObservation = {
  files: string[];
  imports: StructuralImport[];
  exports: StructuralExport[];
  observedAt: string;
  evidenceScope: 'git-tracked' | 'filesystem';
  truncated: boolean;
  skippedFileCount: number;
  externalImportCount: number;
};

export interface CodeStructureObserver {
  scan(input: {
    localPath: string;
    trackedPaths?: readonly string[];
  }): Promise<CodeStructureObservation>;
}

export type CodeStructureObserverOptions = {
  now?: () => Date;
  maximumFiles?: number;
  maximumFileBytes?: number;
};

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function normalizedRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

async function walk(root: string, maximumFiles: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(path);
        // One past the bound is enough to prove truncation without walking on.
        if (files.length > maximumFiles) return files;
      }
    }
  }
  return files;
}

/** Literal specifier of a static import/export or a dynamic `import()`. */
type Specifier = { text: string | null; dynamic: boolean; node: ts.Node };

function collectSpecifiers(source: ts.SourceFile): Specifier[] {
  const found: Specifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      found.push({
        text: ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null,
        dynamic: false,
        node: node.moduleSpecifier,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0]!;
      found.push({
        text: ts.isStringLiteral(argument) ? argument.text : null,
        dynamic: true,
        node: argument,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function exportedSymbols(source: ts.SourceFile): Array<{ symbol: string; node: ts.Node }> {
  const found: Array<{ symbol: string; node: ts.Node }> = [];
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  ts.forEachChild(source, (node) => {
    if (!isExported(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          found.push({ symbol: declaration.name.text, node: declaration.name });
        }
      }
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      found.push({ symbol: node.name.text, node: node.name });
    }
  });
  return found;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function createCodeStructureObserver(
  options: CodeStructureObserverOptions = {},
): CodeStructureObserver {
  const now = options.now ?? (() => new Date());
  const maximumFiles = options.maximumFiles ?? MAX_SCAN_FILES;
  const maximumFileBytes = options.maximumFileBytes ?? MAX_FILE_BYTES;

  return {
    async scan(input) {
      const root = resolve(input.localPath);
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
      } catch {
        throw new CodeStructureError(
          'CODE_STRUCTURE_SCAN_FAILED',
          'The project root could not be resolved.',
        );
      }

      const evidenceScope = input.trackedPaths === undefined ? 'filesystem' : 'git-tracked';
      let candidates: string[];
      if (input.trackedPaths === undefined) {
        candidates = await walk(canonicalRoot, maximumFiles);
      } else {
        candidates = [];
        for (const trackedPath of input.trackedPaths) {
          const absolute = resolve(canonicalRoot, trackedPath);
          if (!isWithin(canonicalRoot, absolute)) {
            throw new CodeStructureError(
              'CODE_STRUCTURE_SCAN_FAILED',
              'A tracked path resolved outside the canonical project root.',
            );
          }
          if (SOURCE_EXTENSIONS.has(extname(absolute).toLowerCase())) candidates.push(absolute);
        }
      }

      candidates = candidates.toSorted();
      const truncated = candidates.length > maximumFiles;
      const selected = candidates.slice(0, maximumFiles);

      const compilerOptions: ts.CompilerOptions = {
        allowJs: false,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
      };
      const resolutionHost: ts.ModuleResolutionHost = {
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
      };

      const files: string[] = [];
      const imports: StructuralImport[] = [];
      const exports: StructuralExport[] = [];
      let skippedFileCount = 0;
      let externalImportCount = 0;

      for (const absolute of selected) {
        let size: number;
        try {
          size = Number((await stat(absolute)).size);
        } catch {
          skippedFileCount += 1;
          continue;
        }
        if (size > maximumFileBytes) {
          skippedFileCount += 1;
          continue;
        }

        let text: string;
        try {
          text = await readFile(absolute, 'utf8');
        } catch {
          skippedFileCount += 1;
          continue;
        }

        const fromPath = normalizedRelative(canonicalRoot, absolute);
        files.push(fromPath);
        const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);

        for (const specifier of collectSpecifiers(source)) {
          const line = lineOf(source, specifier.node);
          if (specifier.text === null) {
            // A computed specifier names no file. ADR 0012 forbids adopting the
            // only plausible target on disk as the answer.
            imports.push({
              fromPath,
              specifier: source.text.slice(
                specifier.node.getStart(source),
                specifier.node.getEnd(),
              ),
              confidence: 'unknown',
              dynamic: specifier.dynamic,
              line,
            });
            continue;
          }

          const resolved = ts.resolveModuleName(
            specifier.text,
            absolute,
            compilerOptions,
            resolutionHost,
          ).resolvedModule;

          const isRelative = specifier.text.startsWith('.');
          if (resolved === undefined) {
            // A bare specifier that resolves nowhere is an external package the
            // scanned tree does not contain — a different question, not a
            // broken intra-project reference. Only a relative specifier that
            // names no file is genuinely unresolvable.
            if (!isRelative) {
              externalImportCount += 1;
              continue;
            }
            imports.push({
              fromPath,
              specifier: specifier.text,
              confidence: 'unknown',
              dynamic: specifier.dynamic,
              line,
            });
            continue;
          }

          const targetAbsolute = resolve(resolved.resolvedFileName);
          if (
            resolved.isExternalLibraryImport === true ||
            !isWithin(canonicalRoot, targetAbsolute)
          ) {
            // A dependency on something that is not a file in this project is a
            // different question, not a weaker answer to this one.
            externalImportCount += 1;
            continue;
          }

          imports.push({
            fromPath,
            toPath: normalizedRelative(canonicalRoot, targetAbsolute),
            specifier: specifier.text,
            // A relative specifier names its target directly. A bare specifier
            // that still landed inside the root did so through a mapping, which
            // is one candidate rather than a literal path.
            confidence: isRelative ? 'high' : 'medium',
            dynamic: specifier.dynamic,
            line,
          });
        }

        for (const { symbol, node } of exportedSymbols(source)) {
          exports.push({ path: fromPath, symbol, line: lineOf(source, node) });
        }
      }

      return {
        files,
        imports,
        exports,
        observedAt: now().toISOString(),
        evidenceScope,
        truncated,
        skippedFileCount,
        externalImportCount,
      };
    },
  };
}

/** Identifies the extractor and its version on every structural record. */
export const CODE_STRUCTURE_PROVENANCE = 'code-structure-observer@1';

export function moduleDependencyPairs(
  imports: readonly StructuralImport[],
  moduleOf: (path: string) => string | null,
): Array<{ from: string; to: string; confidence: 'high' | 'medium' | 'low' }> {
  const best = new Map<
    string,
    { from: string; to: string; confidence: 'high' | 'medium' | 'low' }
  >();
  const rank = { low: 0, medium: 1, high: 2 } as const;
  for (const value of imports) {
    if (value.toPath === undefined || value.confidence === 'unknown') continue;
    const from = moduleOf(value.fromPath);
    const to = moduleOf(value.toPath);
    if (from === null || to === null || from === to) continue;
    const key = `${from} ${to}`;
    const current = best.get(key);
    // A module dependency is as strong as its strongest proven import. Unknown
    // imports contributed nothing above, so nothing is upgraded here.
    if (current === undefined || rank[value.confidence] > rank[current.confidence]) {
      best.set(key, { from, to, confidence: value.confidence });
    }
  }
  return [...best.values()].toSorted(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}
