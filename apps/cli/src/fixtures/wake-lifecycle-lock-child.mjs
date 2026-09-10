import process from 'node:process';
import { setInterval } from 'node:timers';

import { NodeLifecycleFileSystem } from '../lifecycle.js';
import { tryAcquireNodeWakeLifecycleMutex } from '../wake-lifecycle.js';

const identity = process.argv[2];
if (identity === undefined) {
  throw new Error('The lifecycle lock fixture requires an identity path.');
}

const releaseMutex = await tryAcquireNodeWakeLifecycleMutex(identity, 'win32');
if (releaseMutex === undefined) {
  throw new Error('The lifecycle lock fixture could not acquire its Windows mutex.');
}

const fileSystem = new NodeLifecycleFileSystem();
const releaseReceipt = await fileSystem.tryAcquireLock(identity);
if (releaseReceipt === undefined) {
  await releaseMutex();
  throw new Error('The lifecycle lock fixture could not publish its receipt.');
}

const content = await fileSystem.readText(identity, 16 * 1024);
if (content === undefined) {
  await releaseReceipt();
  await releaseMutex();
  throw new Error('The lifecycle lock fixture could not read its receipt.');
}

process.stdout.write(`${JSON.stringify({ state: 'ready', pid: process.pid, content })}\n`);

// Keep both release callbacks reachable and the process alive. The parent
// terminates this fixture without running them to prove kernel mutex cleanup
// and filesystem receipt recovery after an abrupt process exit.
setInterval(() => {
  void releaseReceipt;
  void releaseMutex;
}, 60_000);
