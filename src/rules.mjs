import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export class UserError extends Error {
  constructor(message, code = 'INVALID') { super(message); this.name = 'UserError'; this.code = code; }
}

export function normalizeDomain(input) {
  if (typeof input !== 'string' || input.length > 2048 || !input.trim()) throw new UserError('请输入网站域名或 http / https 网址。');
  let url;
  try { url = new URL(input.includes('://') ? input.trim() : `https://${input.trim()}`); }
  catch { throw new UserError('网址格式不正确，请检查域名。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new UserError('请使用不含账号密码的 http / https 网址。');
  const domain = domainToASCII(url.hostname.replace(/\.$/, '')).toLowerCase();
  const labels = domain.split('.');
  if (isIP(domain.replace(/^\[|\]$/g, '')) || domain.length > 253 || labels.length < 2 || labels.some((s) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) {
    throw new UserError('请填写完整域名；暂不支持 IP、通配符或本地主机名。');
  }
  return domain;
}

export function compileEntries(input, available) {
  if (!Array.isArray(input) || input.length > 500) throw new UserError('一次最多配置 500 条规则。');
  const seen = new Set();
  const entries = input.map((entry) => {
    if (!entry || !['suffix', 'exact'].includes(entry.match)) throw new UserError('请选择有效的域名匹配方式。');
    const domain = normalizeDomain(entry.domain);
    const key = `${entry.match}:${domain}`;
    if (seen.has(key)) throw new UserError(`${domain} 存在重复规则，请合并后再应用。`);
    seen.add(key);
    const target = entry.target;
    if (typeof target !== 'string' || !target || target.length > 512 || /[,\r\n\u0000-\u001f\u007f]/.test(target)) throw new UserError('出口名称含有不支持的字符，请在客户端重命名后重试。');
    if (available && !available.has(target)) throw new UserError(`出口「${target}」已不存在，请重新选择。`);
    return { domain, match: entry.match, target };
  });
  // More specific hosts win; exact rules precede suffix rules for the same host.
  return entries.sort((a, b) => b.domain.split('.').length - a.domain.split('.').length || Number(b.match === 'exact') - Number(a.match === 'exact') || a.domain.localeCompare(b.domain));
}

export const ruleLines = (entries) => entries.map((e) => `${e.match === 'exact' ? 'DOMAIN' : 'DOMAIN-SUFFIX'},${e.domain},${e.target}`);

const START = '// <node-switcher:managed:v1>';
const END = '// </node-switcher:managed:v1>';

export function managedSuffix(entries) {
  const metadata = Buffer.from(JSON.stringify(entries)).toString('base64url');
  const lines = JSON.stringify(ruleLines(entries)).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `\n${START}\n// metadata:${metadata}\n;var __nodeSwitcherOriginalMainV1 = main;\nmain = function(config, profileName) {\n  var result = __nodeSwitcherOriginalMainV1(config, profileName);\n  if (!result || typeof result !== "object") throw new Error("Node Switcher: invalid configuration");\n  var added = ${lines};\n  var previous = Array.isArray(result.rules) ? result.rules : [];\n  result.rules = added.concat(previous);\n  return result;\n};\n${END}\n`;
}

export function readManagedScript(text) {
  const position = text.indexOf(START);
  if (position < 0) {
    if (text.includes(END) || text.includes('__nodeSwitcherOriginalMainV1')) throw new UserError('扩展脚本包含无法识别的 Node Switcher 片段，未作修改。');
    return { base: text, entries: [] };
  }
  const start = position > 0 && text[position - 1] === '\n' ? position - 1 : position;
  const metadata = text.slice(position).match(/^\/\/ <node-switcher:managed:v1>\n\/\/ metadata:([A-Za-z0-9_-]*)\n/);
  if (!metadata) throw new UserError('Node Switcher 扩展片段已被修改，请先恢复脚本。');
  let entries;
  try { entries = compileEntries(JSON.parse(Buffer.from(metadata[1], 'base64url').toString())); }
  catch { throw new UserError('Node Switcher 扩展片段无法读取。'); }
  if (text.slice(start) !== managedSuffix(entries)) throw new UserError('Node Switcher 扩展片段已被手工修改，停止覆盖。');
  return { base: text.slice(0, start), entries };
}

export function replacePrefix(current, previous, next) {
  if (!Array.isArray(current) || current.some((r) => typeof r !== 'string')) throw new UserError('运行配置的 rules 不是有效规则列表。');
  const old = ruleLines(previous);
  if (old.some((r, i) => current[i] !== r)) throw new UserError('已有分流规则顺序发生变化，请先让客户端刷新配置后重新识别。', 'CONFLICT');
  return [...ruleLines(next), ...current.slice(old.length)];
}

export function overlapWarnings(entries) {
  const warnings = [];
  for (const a of entries) for (const b of entries) {
    if (a !== b && b.match === 'suffix' && a.target !== b.target && (a.domain.endsWith(`.${b.domain}`) || (a.domain === b.domain && a.match === 'exact'))) {
      warnings.push(`${a.domain} 将优先走「${a.target}」，其余 ${b.domain} 子域名走「${b.target}」。`);
    }
  }
  return [...new Set(warnings)].slice(0, 8);
}
