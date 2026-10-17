import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { UserError } from './rules.mjs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const same = (a, b) => a.hash === b.hash;

export async function snapshot(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new UserError('配置必须是普通文件，不能是符号链接。');
  if (stat.size > 16 * 1024 * 1024) throw new UserError('配置超过 16 MB，暂不支持直接编辑。');
  const bytes = await fs.readFile(file);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new UserError('配置不是有效 UTF-8 文件，请先转换编码。');
  return { path: file, hash: hash(bytes), mode: stat.mode & 0o777, content };
}

export function yamlDocument(text) {
  const doc = YAML.parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) throw new UserError('YAML 配置无法解析或包含重复字段，请先在客户端修复。');
  let value;
  try { value = doc.toJS({ maxAliasCount: 100 }); }
  catch { throw new UserError('YAML 引用过多，无法安全解析。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('配置根节点必须是 YAML 对象。');
  return { doc, value };
}

export async function assertUnchanged(saved) {
  const current = await snapshot(saved.path);
  if (!same(current, saved)) throw new UserError('配置已被客户端或其他程序修改，请重新预览后再应用。', 'CONFLICT');
}

export async function atomicWrite(file, content, mode = 0o600) {
  const temporary = path.join(path.dirname(file), `.node-switcher-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fs.chmod(temporary, mode & 0o600); // Configuration copies must never become world readable.
    await fs.rename(temporary, file);
    // Best effort directory fsync; not supported by every Windows filesystem.
    const directory = await fs.open(path.dirname(file), 'r').catch(() => null);
    if (directory) { await directory.sync().catch(() => {}); await directory.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new UserError('本地记录无法读取，请先检查备份目录。'); }
}
