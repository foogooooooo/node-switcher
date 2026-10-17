// Synthetic client for the explicit development demo. It never discovers real clients.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import YAML from 'yaml';

export const originalScript = '// 用户原有扩展脚本\nfunction main(config) {\n  config["log-level"] = "warning";\n  return config;\n}\n';

export async function writeFixture(root, controllerPort, { proxyPorts = [19001, 19002], secret = 'synthetic-test-secret' } = {}) {
  await fs.mkdir(path.join(root, 'profiles'), { recursive: true, mode: 0o700 });
  const config = {
    'mixed-port': 0, 'external-controller': `127.0.0.1:${controllerPort}`, secret,
    'allow-lan': false, mode: 'rule', 'log-level': 'silent', ipv6: false,
    dns: { enable: false }, tun: { enable: false },
    proxies: [
      { name: '日本 · 测试节点', type: 'http', server: '127.0.0.1', port: proxyPorts[0] },
      { name: '美国 · 测试节点', type: 'http', server: '127.0.0.1', port: proxyPorts[1] },
    ],
    'proxy-groups': [{ name: '常用出口', type: 'select', proxies: ['日本 · 测试节点', '美国 · 测试节点', 'DIRECT'] }],
    rules: ['DOMAIN-SUFFIX,legacy.routing.test,常用出口', 'MATCH,DIRECT'],
  };
  const registry = { current: 'sample-profile', items: [
    { uid: 'sample-profile', type: 'remote', name: '隔离测试订阅', file: 'sample.yaml', url: 'https://subscription.invalid/test', option: { script: 'sample-script', rules: 'sample-rules' } },
    { uid: 'sample-script', type: 'script', name: '扩展脚本', file: 'script.js' },
    { uid: 'sample-rules', type: 'rules', file: 'rules.yaml' },
  ] };
  await Promise.all([
    fs.writeFile(path.join(root, 'profiles.yaml'), YAML.stringify(registry), { mode: 0o600 }),
    fs.writeFile(path.join(root, 'clash-verge.yaml'), YAML.stringify(config), { mode: 0o600 }),
    fs.writeFile(path.join(root, 'profiles/sample.yaml'), YAML.stringify(config), { mode: 0o600 }),
    fs.writeFile(path.join(root, 'profiles/script.js'), originalScript, { mode: 0o600 }),
    fs.writeFile(path.join(root, 'profiles/rules.yaml'), 'prepend: []\nappend: []\ndelete: []\n', { mode: 0o600 }),
  ]);
  return config;
}

export function apiRules(lines) {
  const types = { DOMAIN: 'Domain', 'DOMAIN-SUFFIX': 'DomainSuffix', 'DOMAIN-KEYWORD': 'DomainKeyword', MATCH: 'Match' };
  return lines.map((line) => {
    const [type, host, target] = line.split(',');
    return { type: types[type] || type, payload: type === 'MATCH' ? '' : host, proxy: type === 'MATCH' ? host : target };
  });
}

export async function createSandbox(root) {
  let config, failReload = false, failVerify = false;
  const server = http.createServer(async (req, res) => {
    const respond = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${config.secret}`) return respond(401, {});
    if (req.method === 'PUT' && req.url.startsWith('/configs')) {
      if (failReload) { failReload = false; return respond(500, { message: 'synthetic failure' }); }
      let body = ''; for await (const chunk of req) body += chunk;
      try { config = YAML.parse(JSON.parse(body).payload); return respond(204); }
      catch { return respond(400, {}); }
    }
    if (req.url === '/version') return respond(200, { version: 'v1.19.21 · 模拟接口', meta: true });
    if (req.url === '/configs') return respond(200, { mode: config.mode, 'mixed-port': config['mixed-port'] });
    if (req.url === '/rules') {
      if (failVerify) { failVerify = false; return respond(200, { rules: [] }); }
      return respond(200, { rules: apiRules(config.rules) });
    }
    if (req.url === '/proxies') {
      const proxies = { DIRECT: { type: 'Direct' }, REJECT: { type: 'Reject' } };
      for (const p of config.proxies || []) proxies[p.name] = { type: 'Http' };
      for (const p of config['proxy-groups'] || []) proxies[p.name] = { type: 'Selector', all: p.proxies, now: p.proxies[0] };
      return respond(200, { proxies });
    }
    return respond(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config = await writeFixture(root, server.address().port);
  return { root, server, getConfig: () => structuredClone(config), setConfig: (value) => { config = structuredClone(value); },
    failNextReload: () => { failReload = true; }, failNextReadback: () => { failVerify = true; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
