import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UserError, compileEntries, ruleLines, overlapWarnings } from './rules.mjs';
import { snapshot, hash, atomicWrite, assertUnchanged, writeJSON, readJSON } from './files.mjs';
import { reopen, liveStatus, changesFor } from './adapters.mjs';
import { assertRules, MihomoAPI } from './api.mjs';

const execute = promisify(execFile);
const FINAL = new Set(['committed', 'rolled-back', 'undone']);

export class RoutingService {
  constructor(dataDir, { validate, makeAPI } = {}) {
    this.dataDir = dataDir; this.plans = new Map(); this.busy = false;
    this.validateOverride = validate; this.makeAPI = makeAPI || ((endpoint) => new MihomoAPI(endpoint));
  }
  async history() {
    const root = path.join(this.dataDir, 'backups');
    const names = await fs.readdir(root).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    const records = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      const record = await readJSON(path.join(root, name, 'journal.json'), null);
      if (record) records.push({ id: record.id, clientId: record.clientId, createdAt: record.createdAt, status: record.status, count: record.entries.length });
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async validate(adapter, content, binary) {
    if (this.validateOverride) return this.validateOverride(adapter, content);
    if (!binary || !path.isAbsolute(binary) || !(await fs.stat(binary)).isFile()) throw new UserError('请先选择 Mihomo 内核程序，用于应用前校验。');
    const file = path.join(adapter.root, `.node-switcher-check-${randomUUID()}.yaml`);
    try {
      await fs.writeFile(file, content, { mode: 0o600, flag: 'wx' });
      await execute(binary, ['-t', '-d', adapter.root, '-f', file], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError('Mihomo 内核校验未通过或超时，原配置尚未修改。请检查出口、规则及内核版本。', 'VALIDATE');
    } finally { await fs.unlink(file).catch(() => {}); }
  }
  async preview(selected, rawEntries, binary) {
    if (this.busy) throw new UserError('另一项配置操作仍在进行。');
    const history = await this.history();
    if (history.some((h) => !FINAL.has(h.status))) throw new UserError('有中断的配置操作，请先在「恢复记录」中恢复。', 'RECOVERY');
    const adapter = await reopen(selected);
    if (adapter.id !== selected.id || JSON.stringify(adapter.managed) !== JSON.stringify(selected.managed)) throw new UserError('订阅或已保存规则发生变化，请重新识别后再编辑。', 'CONFLICT');
    const live = await liveStatus(adapter);
    const entries = compileEntries(rawEntries, new Set(live.targets.map((t) => t.name)));
    const built = changesFor(adapter, entries, live.status);
    await this.validate(adapter, built.runtimeContent, binary);
    for (const guard of [...adapter.guards, ...built.changes.map((c) => c.before)]) await assertUnchanged(guard);
    const id = randomUUID();
    const actualChanges = built.changes.filter((c) => hash(c.content) !== c.before.hash);
    // Bound memory even if the renderer asks for repeated previews.
    this.plans.clear();
    this.plans.set(id, { adapter, entries, ...built, binary, created: Date.now(), changes: actualChanges });
    return { id, entries, profile: adapter.profile, warnings: overlapWarnings(entries),
      files: actualChanges.map((c) => ({ name: path.basename(c.before.path), kind: c.before.path === adapter.runtime.path ? '运行配置' : '持久扩展脚本' })),
      ruleCount: entries.length, unchanged: actualChanges.length === 0,
      note: adapter.kind === 'verge' ? '保存到当前配置的扩展脚本，并立即重载内核。' : '保存到所选运行配置，并立即重载内核。',
    };
  }
  async locked(callback) {
    if (this.busy) throw new UserError('配置操作正在进行，请等待完成。');
    this.busy = true;
    const lock = path.join(this.dataDir, 'operation.lock'); let file;
    try {
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      try { file = await fs.open(lock, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') {
          const owner = await readJSON(lock, {});
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
          if (alive) throw new UserError('另一进程正在使用配置，请关闭另一个 Node Switcher。');
          await fs.unlink(lock); file = await fs.open(lock, 'wx', 0o600);
        } else throw error;
      }
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      return await callback();
    } finally {
      if (file) { await file.close(); await fs.unlink(lock).catch(() => {}); }
      this.busy = false;
    }
  }
  async verify(api, contentRules) {
    const [rules, config] = await Promise.all([api.request('/rules'), api.request('/configs')]);
    assertRules(rules?.rules, contentRules, { full: true });
    if (config?.mode !== 'rule') throw new UserError('重载后客户端不在规则模式，无法确认分流生效。', 'VERIFY');
  }
  async apply(id) {
    return this.locked(async () => {
      const plan = this.plans.get(id); this.plans.delete(id);
      if (!plan || Date.now() - plan.created > 120000) throw new UserError('预览已过期，请重新预览。', 'EXPIRED');
      const { adapter, changes, entries } = plan;
      const history = await this.history();
      if (history.some((h) => !FINAL.has(h.status))) throw new UserError('请先恢复中断的操作。', 'RECOVERY');
      const reopened = await reopen(adapter);
      if (reopened.id !== adapter.id) throw new UserError('当前订阅已切换，请重新识别。', 'CONFLICT');
      for (const guard of [...adapter.guards, adapter.runtime, ...(adapter.script ? [adapter.script] : [])]) await assertUnchanged(guard);
      const api = this.makeAPI(adapter.endpoint);
      await this.verify(api, adapter.config.rules);
      if (!changes.length) return { status: 'unchanged', count: entries.length };
      // Revalidate immediately before writing; preview may have waited for user input.
      await this.validate(adapter, plan.runtimeContent, plan.binary);
      for (const guard of [...adapter.guards, ...changes.map((c) => c.before)]) await assertUnchanged(guard);
      const transaction = randomUUID();
      const directory = path.join(this.dataDir, 'backups', transaction);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const journal = {
        version: 1, id: transaction, clientId: adapter.id, createdAt: new Date(Math.max(Date.now(), ...history.map((h) => Date.parse(h.createdAt) + 1))).toISOString(),
        status: 'prepared', entries, previousEntries: adapter.managed, kind: adapter.kind,
        root: adapter.root, file: adapter.file, runtimePath: adapter.runtime.path, runtimeBeforeHash: adapter.runtime.hash,
        guards: adapter.guards.map(({ path: file, hash: digest }) => ({ path: file, hash: digest })),
        files: changes.map((c, i) => ({ path: c.before.path, beforeHash: c.before.hash, afterHash: hash(c.content), mode: c.before.mode, backup: `${i}.before` })),
      };
      const journalFile = path.join(directory, 'journal.json');
      await atomicWrite(path.join(directory, 'runtime.before'), adapter.runtime.content);
      for (let i = 0; i < changes.length; i++) await atomicWrite(path.join(directory, `${i}.before`), changes[i].before.content);
      await writeJSON(journalFile, journal);
      try {
        for (const change of changes) {
          for (const guard of adapter.guards) await assertUnchanged(guard);
          await assertUnchanged(change.before);
          await atomicWrite(change.before.path, change.content, change.before.mode);
        }
        journal.status = 'files-written'; await writeJSON(journalFile, journal);
        await api.reload(plan.runtimeContent);
        await this.verify(api, plan.rules);
        for (const file of journal.files) {
          if ((await snapshot(file.path)).hash !== file.afterHash) throw new UserError('验证期间配置被其他程序改动，不能确认生效。', 'CONFLICT');
        }
        for (const guard of adapter.guards) await assertUnchanged(guard);
        journal.status = 'committed'; await writeJSON(journalFile, journal);
        return { status: 'committed', id: transaction, count: entries.length };
      } catch (error) {
        journal.status = 'recovery-needed'; await writeJSON(journalFile, journal);
        try {
          await this.restoreJournal(journal, directory, api, 'rolled-back');
          throw new UserError(`${error instanceof UserError ? error.message : '应用失败。'} 已恢复原文件并确认原规则重新加载。`, 'ROLLED_BACK');
        } catch (rollbackError) {
          if (rollbackError.code === 'ROLLED_BACK') throw rollbackError;
          throw new UserError('应用未完成，自动恢复也未能确认。请使用「恢复记录」继续恢复；备份已保存在本机。', 'RECOVERY');
        }
      }
    });
  }
  async restoreJournal(journal, directory, api, finalStatus) {
    // Check every lease first, before touching any file. Never overwrite a user's later edit.
    for (const guard of journal.guards) await assertUnchanged(guard);
    const current = [];
    for (const item of journal.files) {
      const file = await snapshot(item.path);
      if (![item.beforeHash, item.afterHash].includes(file.hash)) throw new UserError('配置已有后续修改，自动恢复会覆盖这些修改，已停止。', 'CONFLICT');
      const backup = await fs.readFile(path.join(directory, item.backup), 'utf8');
      if (hash(backup) !== item.beforeHash) throw new UserError('备份完整性检查失败，停止恢复。');
      current.push({ item, file, backup });
    }
    const content = await fs.readFile(path.join(directory, 'runtime.before'), 'utf8');
    if (hash(content) !== journal.runtimeBeforeHash) throw new UserError('运行配置备份完整性检查失败，停止恢复。');
    const { yamlDocument } = await import('./files.mjs');
    const { value } = yamlDocument(content);
    for (const { item, file, backup } of current) {
      await assertUnchanged(file);
      if (file.hash !== item.beforeHash) await atomicWrite(item.path, backup, item.mode);
    }
    // A crash may leave the runtime restored already; reloading makes recovery repeatable.
    await api.reload(content);
    await this.verify(api, value.rules);
    journal.status = finalStatus;
    await writeJSON(path.join(directory, 'journal.json'), journal);
  }
  async restore(id, selected) {
    return this.locked(async () => {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new UserError('恢复记录无效。');
      const directory = path.join(this.dataDir, 'backups', id);
      const journal = await readJSON(path.join(directory, 'journal.json'), null);
      if (!journal || journal.version !== 1 || journal.id !== id) throw new UserError('恢复记录不存在或版本不受支持。');
      const adapter = await reopen(selected);
      if (adapter.id !== journal.clientId) throw new UserError('请先连接这条记录对应的客户端和订阅。');
      if (journal.status === 'undone' || journal.status === 'rolled-back') return { status: journal.status };
      const history = await this.history();
      const newer = history.find((h) => h.clientId === adapter.id && h.createdAt > journal.createdAt && !['undone', 'rolled-back'].includes(h.status));
      if (newer) throw new UserError('请先撤销较新的应用记录，再恢复这一条。');
      const api = this.makeAPI(adapter.endpoint);
      if (journal.status === 'committed') {
        const { rules } = await api.status();
        const { yamlDocument } = await import('./files.mjs');
        const runtime = yamlDocument((await snapshot(adapter.runtime.path)).content).value;
        assertRules(rules, runtime.rules, { full: true });
      }
      const previousStatus = journal.status;
      journal.status = 'recovery-needed'; await writeJSON(path.join(directory, 'journal.json'), journal);
      try {
        await this.restoreJournal(journal, directory, api, previousStatus === 'committed' ? 'undone' : 'rolled-back');
      } catch (error) {
        // A safe lease conflict before any modification should not block all later work.
        if (error.code === 'CONFLICT' && previousStatus === 'committed') { journal.status = previousStatus; await writeJSON(path.join(directory, 'journal.json'), journal); }
        throw error;
      }
      return { status: journal.status };
    });
  }
}
