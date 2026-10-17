import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { writeFixture } from '../src/sandbox.mjs';
import { defaultBinary, openVerge } from '../src/adapters.mjs';
import { MihomoAPI, assertRules } from '../src/api.mjs';
import { RoutingService } from '../src/service.mjs';
import { UserError } from '../src/rules.mjs';

const binary = process.env.MIHOMO_BIN || await defaultBinary();
if (!binary) { console.error('Set MIHOMO_BIN to a local Mihomo executable before running this integration test.'); process.exit(1); }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-switcher-core-'));
let core, exitA, exitB;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise((r) => server.close(r)); return port;
}
async function testExit(name) {
  let nextArrival = null, release = null;
  const content = JSON.stringify({ exit: name });
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(content); });
  server.on('connect', (req, socket, head) => {
    if (!/\.routing\.test:80$/.test(req.url)) { socket.destroy(); return; }
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const respond = () => {
      const send = () => socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(content)}\r\nConnection: close\r\n\r\n${content}`);
      if (nextArrival) { const callback = nextArrival; nextArrival = null; release = send; callback(); }
      else send();
    };
    if (head.length) respond(); else socket.once('data', respond);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hold: () => new Promise((r) => { nextArrival = r; }), release: () => { release?.(); release = null; },
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}
function requestThrough(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: `http://${host}/check`, headers: { Host: host }, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(`Unexpected test response: HTTP ${res.statusCode}`)); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('test request timed out'))); req.on('error', reject);
  });
}

try {
  exitA = await testExit('A'); exitB = await testExit('B');
  const controllerPort = await freePort(), mixedPort = await freePort();
  const clientDir = path.join(root, 'client');
  const initial = await writeFixture(clientDir, controllerPort, { proxyPorts: [exitA.port, exitB.port] });
  initial['mixed-port'] = mixedPort; initial.rules[initial.rules.length - 1] = 'MATCH,常用出口';
  const runtimePath = path.join(clientDir, 'clash-verge.yaml');
  await fs.writeFile(runtimePath, YAML.stringify(initial), { mode: 0o600 });
  await fs.writeFile(path.join(clientDir, 'profiles/sample.yaml'), YAML.stringify(initial), { mode: 0o600 });
  const api = new MihomoAPI({ hostname: '127.0.0.1', port: controllerPort, secret: initial.secret }, 3000);
  async function startCore() {
    core = spawn(binary, ['-d', clientDir, '-f', runtimePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    core.stdout.resume(); core.stderr.resume();
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if (core.exitCode !== null) throw new Error('Isolated Mihomo failed to start.');
      try { await api.request('/version'); return; } catch { await delay(100); }
    }
    throw new Error('Isolated Mihomo did not become ready.');
  }
  async function stopCore() {
    if (core && core.exitCode === null) { core.kill('SIGTERM'); await new Promise((r) => core.once('exit', r)); }
    core = null;
  }
  await startCore();
  const service = new RoutingService(path.join(root, 'data'));
  const entries = [
    { domain: 'alpha.routing.test', match: 'suffix', target: '日本 · 测试节点' },
    { domain: 'beta.routing.test', match: 'exact', target: '美国 · 测试节点' },
  ];
  const plan = await service.preview(await openVerge(clientDir), entries, binary);
  const applied = await service.apply(plan.id); assert.equal(applied.status, 'committed');
  const arrived = exitB.hold();
  const request = requestThrough(mixedPort, 'beta.routing.test');
  await Promise.race([arrived, delay(5000).then(() => { throw new Error('Test exit B was never used.'); })]);
  const connections = await api.request('/connections');
  assert.ok(connections.connections.some((c) => c.metadata.host === 'beta.routing.test' && c.chains.includes('美国 · 测试节点') && c.rule === 'Domain' && c.rulePayload === 'beta.routing.test'), 'Core must report the expected rule and proxy chain');
  exitB.release(); assert.equal((await request).exit, 'B');
  assert.equal((await requestThrough(mixedPort, 'sub.alpha.routing.test')).exit, 'A');
  assert.equal((await requestThrough(mixedPort, 'sub.beta.routing.test')).exit, 'A', 'Exact domain rules must not capture subdomains');

  await service.restore(applied.id, await openVerge(clientDir));
  assert.equal((await requestThrough(mixedPort, 'beta.routing.test')).exit, 'A', 'Undo must restore fallback routing');
  await service.apply((await service.preview(await openVerge(clientDir), entries, binary)).id);

  // Replay the official profile-script stage with a changed synthetic subscription.
  const source = structuredClone(initial); source.rules.unshift('DOMAIN,updated.routing.test,DIRECT');
  await fs.writeFile(path.join(clientDir, 'profiles/sample.yaml'), YAML.stringify(source), { mode: 0o600 });
  const context = vm.createContext({ input: source });
  vm.runInContext(await fs.readFile(path.join(clientDir, 'profiles/script.js'), 'utf8'), context);
  const regenerated = vm.runInContext('main(input, "subscription update")', context);
  await fs.writeFile(runtimePath, YAML.stringify(regenerated), { mode: 0o600 });
  await api.reload(YAML.stringify(regenerated));
  assertRules((await api.request('/rules')).rules, regenerated.rules, { full: true });
  await stopCore(); await startCore();
  assert.equal((await requestThrough(mixedPort, 'beta.routing.test')).exit, 'B', 'Rules must survive subscription regeneration and core restart');

  let injectFailure = true;
  const failing = new RoutingService(path.join(root, 'fault-data'), { makeAPI: () => ({
    request: (...args) => api.request(...args),
    reload: async (content) => { await api.reload(content); if (injectFailure) { injectFailure = false; throw new UserError('synthetic lost response', 'TIMEOUT'); } },
  }) });
  const changed = entries.map((e) => ({ ...e, target: '日本 · 测试节点' }));
  const failingPlan = await failing.preview(await openVerge(clientDir), changed, binary);
  await assert.rejects(failing.apply(failingPlan.id), { code: 'ROLLED_BACK' });
  assert.equal((await requestThrough(mixedPort, 'beta.routing.test')).exit, 'B', 'Ambiguous reload failure must restore the previous working route');
  await stopCore();
  console.log('Real Mihomo integration passed: local exits A/B, domain/suffix routing, connection-chain evidence, undo, subscription-script replay, core restart, lost-response rollback. No external websites or real nodes used.');
} finally {
  if (core && core.exitCode === null) core.kill('SIGTERM');
  exitA?.release(); exitB?.release();
  await Promise.all([exitA?.close(), exitB?.close()]);
  await fs.rm(root, { recursive: true, force: true });
}
