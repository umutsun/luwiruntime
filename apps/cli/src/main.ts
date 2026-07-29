#!/usr/bin/env node

import { toPublicError } from '@luwi/runtime';

import { runCli } from './cli.js';

void runCli(process.argv.slice(2)).catch((error: unknown) => {
  const publicError = toPublicError(error);
  process.stderr.write(`${JSON.stringify(publicError.body.error)}\n`);
  process.exitCode = 1;
});
