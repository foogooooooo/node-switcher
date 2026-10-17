import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import YAML from 'yaml';
import { createSandbox, originalScript } from '../src/sandbox.mjs';
import { RoutingService } from '../src/service.mjs';
import { openVerge, openStandalone, liveStatus } from '../src/adapters.mjs';
import { snapshot, readJSON, writeJSON, yamlDocument } from '../src/files.mjs';
import { MihomoAPI } from '../src/api.mjs';

const entries = [{ domain: 'example.com', match: 'suffix', target: '日本 · 测试节点' }];
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-switcher-test-'));
  const sandbox = await createSandbox(path.join(root, 'client'));
  t.after(async () => { await sandbox.close(); await fs.rm(root, { recursive: true, force: true }); });
  const adapter = await openVerge(sandbox.root);
  const dataDir = path.join(root, 'data');
  const service = new RoutingService(dataDir, { validate: async () => {}, ...options });
  const preview = (items = entries) => service.preview(adapter, items);
  return { root, sandbox, adapter, dataDir, service, preview };
}

test('apply writes persistent extension, verifies runtime and restores byte-for-byte', async (t) => {
  const x = await setup(t); const before = await snapshot(x.adapter.runtime.path);
  const plan = await x.preview(); const result = await x.service.apply(plan.id);
  assert.equal(result.status, 'committed');
  assert.equal(x.sandbox.getConfig().rules[0], 'DOMAIN-SUFFIX,example.com,日本 · 测试节点');
  const updated = await openVerge(x.sandbox.root); assert.deepEqual(updated.managed, entries);
  assert.ok(updated.script.content.startsWith(originalScript));
  const journal = path.join(x.dataDir, 'backups', result.id, 'journal.json');
  if (process.platform !== 'win32') assert.equal((await fs.stat(journal)).mode & 0o077, 0);
  await x.service.restore(result.id, updated);
  assert.equal((await snapshot(x.adapter.runtime.path)).hash, before.hash);
  assert.equal(await fs.readFile(updated.script.path, 'utf8'), originalScript);
  assert.equal((await x.service.history())[0].status, 'undone');
});
test('reapplying the same rules is idempotent', async (t) => {
  const x = await setup(t); await x.service.apply((await x.preview()).id);
  const updated = await openVerge(x.sandbox.root);
  const second = await x.service.preview(updated, entries); assert.equal(second.unchanged, true);
  assert.equal((await x.service.apply(second.id)).status, 'unchanged');
  assert.equal((await x.service.history()).length, 1);
});
test('editing and deleting owned rules preserves pre-existing rules and script', async (t) => {
  const x = await setup(t); await x.service.apply((await x.preview()).id);
  const changed = [{ ...entries[0], target: '美国 · 测试节点' }];
  await x.service.apply((await x.service.preview(await openVerge(x.sandbox.root), changed)).id);
  assert.equal(x.sandbox.getConfig().rules.filter((r) => r.includes('example.com')).length, 1);
  await x.service.apply((await x.service.preview(await openVerge(x.sandbox.root), [])).id);
  assert.deepEqual(x.sandbox.getConfig().rules, ['DOMAIN-SUFFIX,legacy.routing.test,常用出口', 'MATCH,DIRECT']);
  assert.equal(await fs.readFile(x.adapter.script.path, 'utf8'), originalScript);
});
test('subscription regeneration keeps managed rules after the user script', async (t) => {
  const x = await setup(t); await x.service.apply((await x.preview()).id);
  const base = YAML.parse(await fs.readFile(path.join(x.sandbox.root, 'profiles/sample.yaml'), 'utf8'));
  base.rules = ['DOMAIN,updated.routing.test,DIRECT', 'MATCH,DIRECT'];
  const context = vm.createContext({ input: base });
  vm.runInContext(await fs.readFile(x.adapter.script.path, 'utf8'), context);
  const regenerated = vm.runInContext('main(input, "updated subscription")', context);
  assert.equal(regenerated.rules[0], 'DOMAIN-SUFFIX,example.com,日本 · 测试节点');
  assert.equal(regenerated.rules[1], 'DOMAIN,updated.routing.test,DIRECT');
  assert.equal(regenerated['log-level'], 'warning');
});
test('stale preview refuses external file edits without changing anything', async (t) => {
  const x = await setup(t); const plan = await x.preview();
  const changed = `${originalScript}\n// user edited this\n`; await fs.writeFile(x.adapter.script.path, changed);
  await assert.rejects(x.service.apply(plan.id), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(x.adapter.script.path, 'utf8'), changed);
  assert.equal((await x.service.history()).length, 0);
});
test('changed subscription registry invalidates preview', async (t) => {
  const x = await setup(t); const plan = await x.preview();
  await fs.appendFile(path.join(x.sandbox.root, 'profiles.yaml'), '\n# external update\n');
  await assert.rejects(x.service.apply(plan.id), { code: 'CONFLICT' });
});
test('validation failures never write user files or create a transaction', async (t) => {
  const x = await setup(t, { validate: async () => { throw new Error('synthetic validation failure'); } });
  const before = await snapshot(x.adapter.runtime.path);
  await assert.rejects(x.preview(), /synthetic/);
  assert.equal((await snapshot(x.adapter.runtime.path)).hash, before.hash);
  assert.equal((await x.service.history()).length, 0);
});
test('reload failure automatically restores both files and confirms original runtime', async (t) => {
  const x = await setup(t); const before = await snapshot(x.adapter.runtime.path); const plan = await x.preview();
  x.sandbox.failNextReload(); await assert.rejects(x.service.apply(plan.id), { code: 'ROLLED_BACK' });
  assert.equal((await snapshot(x.adapter.runtime.path)).hash, before.hash);
  assert.equal(await fs.readFile(x.adapter.script.path, 'utf8'), originalScript);
  assert.equal(x.sandbox.getConfig().rules.length, 2);
  assert.equal((await x.service.history())[0].status, 'rolled-back');
});
test('a later external edit blocks undo and is never overwritten', async (t) => {
  const x = await setup(t); const result = await x.service.apply((await x.preview()).id);
  const current = await openVerge(x.sandbox.root);
  const edited = `// later user change\n${current.script.content}`; await fs.writeFile(current.script.path, edited);
  await assert.rejects(x.service.restore(result.id, current), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(current.script.path, 'utf8'), edited);
  assert.equal((await x.service.history())[0].status, 'committed');
});
test('interrupted operation recovers after restart, and recovery is repeatable', async (t) => {
  const x = await setup(t); const result = await x.service.apply((await x.preview()).id);
  const journalFile = path.join(x.dataDir, 'backups', result.id, 'journal.json');
  const record = await readJSON(journalFile); record.status = 'files-written'; await writeJSON(journalFile, record);
  const fresh = new RoutingService(x.dataDir, { validate: async () => {} });
  await assert.rejects(fresh.preview(await openVerge(x.sandbox.root), entries), { code: 'RECOVERY' });
  assert.equal((await fresh.restore(result.id, await openVerge(x.sandbox.root))).status, 'rolled-back');
  assert.equal((await fresh.restore(result.id, await openVerge(x.sandbox.root))).status, 'rolled-back');
});
test('corrupt backup is rejected', async (t) => {
  const x = await setup(t); const result = await x.service.apply((await x.preview()).id);
  await fs.writeFile(path.join(x.dataDir, 'backups', result.id, '0.before'), 'corrupt');
  await assert.rejects(x.service.restore(result.id, await openVerge(x.sandbox.root)), /完整性/);
});
test('wrong API credentials fail before any configuration change', async (t) => {
  const x = await setup(t); const api = new MihomoAPI({ ...x.adapter.endpoint, secret: 'wrong' });
  await assert.rejects(api.status(), { code: 'AUTH' });
  assert.equal(await fs.readFile(x.adapter.script.path, 'utf8'), originalScript);
});
test('standalone adapter saves managed metadata and supports undo', async (t) => {
  const x = await setup(t);
  const standaloneFile = path.join(x.root, 'independent.yaml');
  await fs.copyFile(x.adapter.runtime.path, standaloneFile);
  const standalone = await openStandalone(standaloneFile);
  const result = await x.service.apply((await x.service.preview(standalone, entries)).id);
  const current = await openStandalone(standalone.file);
  assert.deepEqual(current.managed, entries); assert.equal(yamlDocument(current.runtime.content).value['x-node-switcher'].version, 1);
  await x.service.restore(result.id, current);
  assert.equal((await openStandalone(standalone.file)).managed.length, 0);
});
test('changing away from rule mode prevents applying misleading rules', async (t) => {
  const x = await setup(t); const config = x.sandbox.getConfig(); config.mode = 'global'; x.sandbox.setConfig(config);
  await assert.rejects(x.preview(), /规则模式/);
});
test('a disappeared node is rejected before writing', async (t) => {
  const x = await setup(t); const config = x.sandbox.getConfig(); config.proxies.shift(); x.sandbox.setConfig(config);
  await assert.rejects(x.preview(), /已不存在/);
});
test('preview expires and cannot be reused after an apply', async (t) => {
  const x = await setup(t); const plan = await x.preview();
  x.service.plans.get(plan.id).created -= 120001;
  await assert.rejects(x.service.apply(plan.id), { code: 'EXPIRED' });
  await assert.rejects(x.service.apply(plan.id), { code: 'EXPIRED' });
});

test('concurrent apply requests cannot create overlapping transactions', async (t) => {
  const x = await setup(t); const plan = await x.preview();
  const results = await Promise.allSettled([x.service.apply(plan.id), x.service.apply(plan.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await x.service.history()).length, 1);
});
test('failed rule readback triggers rollback even when reload returned success', async (t) => {
  const x = await setup(t); const api = new MihomoAPI(x.adapter.endpoint); let inject = true;
  x.service.makeAPI = () => ({ request: (...args) => api.request(...args), reload: async (content) => {
    await api.reload(content); if (inject) { inject = false; x.sandbox.failNextReadback(); }
  } });
  const plan = await x.preview(); await assert.rejects(x.service.apply(plan.id), { code: 'ROLLED_BACK' });
  assert.equal(x.sandbox.getConfig().rules.length, 2);
});
test('failed rollback blocks new operations until explicit recovery succeeds', async (t) => {
  const x = await setup(t); const api = new MihomoAPI(x.adapter.endpoint); let fail = true;
  x.service.makeAPI = () => ({ request: (...args) => api.request(...args), reload: (content) => {
    if (fail) throw new Error('synthetic offline'); return api.reload(content);
  } });
  await assert.rejects(x.service.apply((await x.preview()).id), { code: 'RECOVERY' });
  const current = await openVerge(x.sandbox.root);
  await assert.rejects(x.service.preview(current, entries), { code: 'RECOVERY' });
  fail = false; const record = (await x.service.history())[0];
  assert.equal((await x.service.restore(record.id, current)).status, 'rolled-back');
});
test('comments and async functions cannot masquerade as a supported script entry', async (t) => {
  const x = await setup(t);
  for (const script of ['// function main(config) {}\nvar other = 1;', 'async function main(config) { return config; }']) {
    await fs.writeFile(x.adapter.script.path, script);
    await assert.rejects(openVerge(x.sandbox.root), /同步 main/);
  }
});
test('generated Clash Verge files cannot be mistaken for standalone configurations', async (t) => {
  const x = await setup(t);
  await assert.rejects(openStandalone(x.adapter.runtime.path), /选择目录/);
});
test('invalid UTF-8 files are refused before backup and editing', async (t) => {
  const x = await setup(t); const file = path.join(x.root, 'invalid.yaml');
  await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(snapshot(file), /UTF-8/);
});
