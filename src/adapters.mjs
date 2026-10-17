import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { parse } from 'acorn';
import { hash, snapshot, yamlDocument } from './files.mjs';
import { controller, MihomoAPI, assertRules } from './api.mjs';
import { UserError, readManagedScript, managedSuffix, compileEntries, replacePrefix } from './rules.mjs';

const APP_ID = 'io.github.clash-verge-rev.clash-verge-rev';
const META = 'x-node-switcher';

export function defaultRoots(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return [path.join(home, 'Library/Application Support', APP_ID)];
  if (platform === 'win32') return [path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), APP_ID)];
  return [path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), APP_ID)];
}

export async function discover(roots = defaultRoots()) {
  const results = [];
  for (const root of roots) {
    try {
      await fs.access(path.join(root, 'profiles.yaml'));
      const adapter = await openVerge(root);
      results.push({ kind: 'verge', root, id: adapter.id, name: 'Clash Verge Rev', profile: adapter.profile });
    } catch (error) {
      if (error.code !== 'ENOENT') results.push({ kind: 'verge', root, name: 'Clash Verge Rev', error: error instanceof UserError ? error.message : '无法读取此客户端的配置。' });
    }
  }
  return results;
}

function profilePath(root, filename) {
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename || /[\\/]/.test(filename) || ['.', '..'].includes(filename)) throw new UserError('客户端的扩展文件路径不受支持。');
  return path.join(root, 'profiles', filename);
}

export async function openVerge(input) {
  const root = await fs.realpath(input);
  const registry = await snapshot(path.join(root, 'profiles.yaml'));
  const { value: profiles } = yamlDocument(registry.content);
  const active = profiles.items?.find((item) => item.uid === profiles.current);
  if (!active || !['remote', 'local'].includes(active.type)) throw new UserError('请先在 Clash Verge Rev 中选择一个本地配置或订阅。');
  const script = profiles.items.find((item) => item.uid === active.option?.script);
  if (!script || script.type !== 'script') throw new UserError('此配置没有可用的专属扩展脚本，暂不能直接应用。请先在客户端为此配置创建扩展脚本。');
  const scriptSnapshot = await snapshot(profilePath(root, script.file));
  const source = await snapshot(profilePath(root, active.file));
  const runtime = await snapshot(path.join(root, 'clash-verge.yaml'));
  const parsed = yamlDocument(runtime.content);
  const managed = readManagedScript(scriptSnapshot.content);
  let program;
  try { program = parse(managed.base, { ecmaVersion: 'latest', sourceType: 'script' }); }
  catch { throw new UserError('现有扩展脚本未通过语法检查。'); }
  if (!program.body.some((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'main' && !node.async && !node.generator)) throw new UserError('扩展脚本没有标准的同步 main 函数，暂不能安全接入。');
  return {
    kind: 'verge', root, id: hash(`${root}:${active.uid}`).slice(0, 24),
    profile: typeof active.name === 'string' ? active.name : '当前配置',
    runtime, script: scriptSnapshot, guards: [registry, source],
    config: parsed.value, document: parsed.doc, managed: managed.entries, scriptBase: managed.base,
    endpoint: controller(parsed.value, root),
  };
}

export async function openStandalone(input) {
  const file = await fs.realpath(input);
  const parent = path.dirname(file);
  const likelyVergeRoot = path.basename(parent) === 'profiles' ? path.dirname(parent) : parent;
  if (await fs.access(path.join(likelyVergeRoot, 'profiles.yaml')).then(() => true, () => false)) throw new UserError('这是 Clash Verge Rev 管理的配置，请使用「选择目录」连接客户端数据目录。');
  const runtime = await snapshot(file);
  const { doc, value } = yamlDocument(runtime.content);
  const metadata = value[META];
  if (metadata && (metadata.version !== 1 || !Array.isArray(metadata.entries))) throw new UserError('此配置的 Node Switcher 元数据不受支持。');
  const entries = compileEntries(metadata?.entries || []);
  return { kind: 'standalone', root: path.dirname(file), file,
    id: hash(file).slice(0, 24), profile: path.basename(file), runtime, guards: [], config: value, document: doc,
    managed: entries, endpoint: controller(value, path.dirname(file)),
  };
}

export const reopen = (adapter) => adapter.kind === 'verge' ? openVerge(adapter.root) : openStandalone(adapter.file);

export async function liveStatus(adapter) {
  const api = new MihomoAPI(adapter.endpoint);
  const status = await api.status();
  const targets = Object.entries(status.proxies)
    .filter(([name, proxy]) => name !== 'GLOBAL' && name !== 'PASS' && name !== 'COMPATIBLE' && !/[,\r\n\u0000-\u001f\u007f]/.test(name) && proxy.type !== 'Pass')
    .map(([name, proxy]) => ({ name, type: proxy.type, group: Array.isArray(proxy.all), current: proxy.now || null }))
    .sort((a, b) => Number(b.group) - Number(a.group) || a.name.localeCompare(b.name));
  return { api, status, targets };
}

export function changesFor(adapter, entries, status) {
  if (status.config?.mode !== 'rule' || (adapter.config.mode || 'rule') !== 'rule') throw new UserError('客户端当前不在规则模式。请先在客户端切换到「规则模式」，再重新识别。');
  assertRules(status.rules, adapter.config.rules, { full: true });
  const rules = replacePrefix(adapter.config.rules, adapter.managed, entries);
  adapter.document.set('rules', rules);
  if (adapter.kind === 'standalone') {
    if (entries.length) adapter.document.set(META, { version: 1, entries });
    else adapter.document.delete(META);
  }
  const runtimeContent = adapter.document.toString({ lineWidth: 0 });
  const changes = [{ before: adapter.runtime, content: runtimeContent }];
  if (adapter.kind === 'verge') {
    const content = adapter.scriptBase + (entries.length ? managedSuffix(entries) : '');
    try { new vm.Script(content); } catch { throw new UserError('生成的扩展脚本未通过语法检查，未写入。'); }
    changes.unshift({ before: adapter.script, content });
  }
  return { changes, rules, runtimeContent };
}

export async function defaultBinary() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo', '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo-alpha']
    : [];
  for (const file of candidates) {
    try { if ((await fs.stat(file)).isFile()) return file; } catch { /* optional */ }
  }
  return null;
}
