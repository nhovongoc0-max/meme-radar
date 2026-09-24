import { runUpdateWorker } from '../src/updater.mjs';

// Spawned only from a verified local updater plan; never accepts a URL, command
// string, credentials, or a user-selected executable from an HTTP request.
try {
  if (process.argv.length !== 3) throw Error('invalid plan');
  await runUpdateWorker(process.argv[2]);
} catch { process.exitCode = 1; }
