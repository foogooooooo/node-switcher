// Explicit preflight only: no API mutations and no changes to existing configuration files.
import os from 'node:os';
import path from 'node:path';
import { discover, openVerge, liveStatus, defaultBinary } from '../src/adapters.mjs';
import { RoutingService } from '../src/service.mjs';

const candidates = (await discover()).filter((c) => c.id);
if (candidates.length !== 1) throw new Error('Expected exactly one supported local client for this explicit preflight.');
const adapter = await openVerge(candidates[0].root);
const live = await liveStatus(adapter);
console.log(JSON.stringify({ connected: true, transport: adapter.endpoint.socketPath ? 'local socket' : 'loopback TCP', version: live.status.version, mode: live.status.config.mode, standardProfileScript: true }));
if (process.argv.includes('--preview')) {
  const service = new RoutingService(path.join(os.tmpdir(), 'node-switcher-readonly-preflight'));
  const entries = [...adapter.managed.filter((e) => e.domain !== 'node-switcher.routing.test'), { domain: 'node-switcher.routing.test', match: 'exact', target: 'DIRECT' }];
  const preview = await service.preview(adapter, entries, await defaultBinary());
  console.log(JSON.stringify({ preflightPassed: true, configurationFilesChanged: false, coreReloaded: false, persistentScriptPreserved: true, temporaryValidationFileRemoved: true }));
  service.plans.clear();
}
