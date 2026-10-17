import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { normalizeDomain, compileEntries, ruleLines, managedSuffix, readManagedScript, replacePrefix, overlapWarnings } from '../src/rules.mjs';
import { controller, apiRuleMatches } from '../src/api.mjs';

test('normalizes complete URLs, trailing dots, case and international domains', () => {
  assert.equal(normalizeDomain('https://WWW.Example.COM:443/a?b=1#x'), 'www.example.com');
  assert.equal(normalizeDomain('example.com.'), 'example.com');
  assert.equal(normalizeDomain('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
});
test('rejects IPs, credentials, scripts and wildcard rules', () => {
  for (const input of ['', '*.example.com', 'localhost', '127.0.0.1', '[::1]', 'https://user:pass@example.com', 'file://example.com/a', 'https://bad_domain.com']) assert.throws(() => normalizeDomain(input), undefined, input);
});
test('rejects duplicate rules, missing targets and grammar injection', () => {
  const a = { domain: 'example.com', match: 'suffix', target: '日本' };
  assert.throws(() => compileEntries([a, a]), /重复/);
  assert.throws(() => compileEntries([a], new Set(['美国'])), /已不存在/);
  assert.throws(() => compileEntries([{ ...a, target: 'node\nMATCH,DIRECT' }]), /字符/);
});
test('specific domains and exact rules take priority over parent suffixes', () => {
  const entries = compileEntries([
    { domain: 'example.com', match: 'suffix', target: 'A' },
    { domain: 'example.com', match: 'exact', target: 'B' },
    { domain: 'news.example.com', match: 'suffix', target: 'C' },
  ]);
  assert.deepEqual(ruleLines(entries), ['DOMAIN-SUFFIX,news.example.com,C', 'DOMAIN,example.com,B', 'DOMAIN-SUFFIX,example.com,A']);
  assert.equal(overlapWarnings(entries).length, 2);
});
test('managed wrapper preserves original script and applies rules after user transformations', () => {
  const base = '// custom\nfunction main(config) { config.rules = ["MATCH,DIRECT"]; config.custom = 42; return config; }\n';
  const entries = compileEntries([{ domain: 'example.com', match: 'suffix', target: '日本' }]);
  const script = base + managedSuffix(entries);
  const context = vm.createContext({}); vm.runInContext(script, context);
  const result = vm.runInContext('main({ rules: [] }, "test")', context);
  assert.deepEqual(Array.from(result.rules), ['DOMAIN-SUFFIX,example.com,日本', 'MATCH,DIRECT']);
  assert.equal(result.custom, 42);
  assert.equal(readManagedScript(script).base, base);
  assert.deepEqual(readManagedScript(script).entries, entries);
  assert.throws(() => readManagedScript(script.replace('added.concat', 'previous.concat')), /修改/);
});
test('wrapper quoting cannot turn a proxy name into executable code or metadata', () => {
  const name = 'node"; globalThis.injected = true; // </node-switcher:managed:v1>';
  const entries = compileEntries([{ domain: 'example.com', match: 'exact', target: name }]);
  const script = 'function main(config) { return config; }' + managedSuffix(entries);
  const context = vm.createContext({}); vm.runInContext(script, context);
  assert.equal(context.injected, undefined);
  assert.equal(vm.runInContext('main({rules:[]}).rules[0]', context), `DOMAIN,example.com,${name}`);
  assert.deepEqual(readManagedScript(script).entries, entries);
});
test('prefix replacement only removes owned rules and detects reordering', () => {
  const old = [{ domain: 'example.com', match: 'suffix', target: 'A' }];
  assert.deepEqual(replacePrefix(['DOMAIN-SUFFIX,example.com,A', 'MATCH,DIRECT'], old, []), ['MATCH,DIRECT']);
  assert.throws(() => replacePrefix(['MATCH,DIRECT'], old, []), /顺序/);
});
test('controller uses loopback and rejects remote origins and URL tricks', () => {
  assert.equal(controller({ 'external-controller': '0.0.0.0:9090' }, '/tmp').hostname, '127.0.0.1');
  assert.equal(controller({ 'external-controller': '[::1]:9090' }, '/tmp').hostname, '::1');
  for (const address of ['example.com:9090', '127.0.0.1:9090@evil.test', '127.0.0.1:9090/path', '127.0.0.1:9090?x=1']) assert.throws(() => controller({ 'external-controller': address }, '/tmp'));
});
test('actual rules require both matching domain and target', () => {
  assert.equal(apiRuleMatches('DOMAIN-SUFFIX,example.com,A', { type: 'DomainSuffix', payload: 'example.com', proxy: 'A' }), true);
  assert.equal(apiRuleMatches('DOMAIN-SUFFIX,example.com,A', { type: 'DomainSuffix', payload: 'example.com', proxy: 'B' }), false);
});
