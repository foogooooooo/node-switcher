import http from 'node:http';
import path from 'node:path';
import { UserError } from './rules.mjs';

export function controller(config, dir) {
  // Prefer the client's Unix socket, which is available even if the TCP API is disabled.
  if (process.platform !== 'win32' && config['external-controller-unix']) {
    const socket = config['external-controller-unix'];
    if (typeof socket !== 'string' || socket.includes('\0')) throw new UserError('客户端的本地 socket 配置不正确。');
    return { socketPath: path.resolve(dir, socket), secret: '' };
  }
  if (process.platform === 'win32' && config['external-controller-pipe']) {
    const pipe = config['external-controller-pipe'];
    if (typeof pipe !== 'string' || !pipe.startsWith('\\\\.\\pipe\\')) throw new UserError('客户端的本地命名管道配置不正确。');
    return { socketPath: pipe, secret: '' };
  }
  const address = config['external-controller'];
  if (typeof address !== 'string' || !address) throw new UserError('未找到本地控制接口。请在客户端启用控制接口，或选择正确的运行配置。');
  let url;
  try { url = new URL(`http://${address}`); }
  catch { throw new UserError('控制接口地址无法识别。'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname)) {
    throw new UserError('此版本只连接本机控制接口，请将控制接口设为本机地址。');
  }
  const port = Number(url.port || 80);
  return { hostname: ['[::1]', '[::]'].includes(url.hostname) ? '::1' : '127.0.0.1', port, secret: typeof config.secret === 'string' ? config.secret : '' };
}

export class MihomoAPI {
  constructor(endpoint, timeout = 8000) { this.endpoint = endpoint; this.timeout = timeout; }
  async request(route, method = 'GET', data) {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const { secret, ...endpoint } = this.endpoint;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      const req = http.request({ ...endpoint, path: route, method, agent: false,
        headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, (res) => {
        let size = 0; const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 24 * 1024 * 1024) { fail(new UserError('控制接口返回内容过大。')); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on('error', () => fail(new UserError('读取本地控制接口时连接中断。')));
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode === 401 || res.statusCode === 403) return fail(new UserError('本地控制接口认证失败，请重新识别客户端。', 'AUTH'));
          if (res.statusCode < 200 || res.statusCode >= 300) return fail(new UserError(`客户端拒绝了操作（HTTP ${res.statusCode}），未确认生效。`, 'API'));
          try {
            const text = Buffer.concat(chunks).toString();
            const result = text ? JSON.parse(text) : null;
            settled = true; resolve(result);
          } catch { fail(new UserError('客户端返回了无法识别的数据。')); }
        });
      });
      const timer = setTimeout(() => { fail(new UserError('本地控制接口超时，未确认生效。', 'TIMEOUT')); req.destroy(); }, this.timeout);
      req.on('close', () => clearTimeout(timer));
      req.on('error', () => fail(new UserError('无法连接本地客户端，请确认客户端和代理内核正在运行。', 'OFFLINE')));
      if (body) req.write(body);
      req.end();
    });
  }
  async status() {
    const [version, config, proxies, rules] = await Promise.all([
      this.request('/version'), this.request('/configs'), this.request('/proxies'), this.request('/rules'),
    ]);
    if (!proxies?.proxies || !Array.isArray(rules?.rules) || typeof version?.version !== 'string') throw new UserError('控制接口不符合受支持的 Mihomo 格式。');
    return { version: version.version, config, proxies: proxies.proxies, rules: rules.rules };
  }
  reload(content) { return this.request('/configs?force=true', 'PUT', { payload: content }); }
}

const TYPES = { DOMAIN: 'Domain', 'DOMAIN-SUFFIX': 'DomainSuffix', 'DOMAIN-KEYWORD': 'DomainKeyword', MATCH: 'Match' };
export function apiRuleMatches(line, actual) {
  const [type, payload, target] = line.split(',');
  const expectedType = TYPES[type];
  if (!expectedType || !actual) return null;
  return actual.type?.toLowerCase() === expectedType.toLowerCase() && (type === 'MATCH' ? actual.proxy === payload : actual.payload === payload && actual.proxy === target);
}

export function assertRules(actual, expected, { full = false } = {}) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || (full ? actual.length !== expected.length : actual.length < expected.length)) throw new UserError('实际加载的规则数量与配置不一致，停止操作。', 'VERIFY');
  for (let i = 0; i < expected.length; i++) {
    if (apiRuleMatches(expected[i], actual[i]) === false) throw new UserError('实际加载的规则与配置不一致，停止操作。', 'VERIFY');
  }
}
