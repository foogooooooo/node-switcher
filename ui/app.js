/* The renderer never reads configuration files or receives node credentials. */
const $ = (id) => document.getElementById(id);
const bridge = window.routing;
let client = null, entries = [], baseline = '[]', history = [], candidates = [], busy = false, plan = null, demo = false;
const isDirty = () => JSON.stringify(entries) !== baseline;
const icon = (name) => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#${name}`); svg.append(use); return svg; };
const text = (tag, content, className) => { const element = document.createElement(tag); element.textContent = content; if (className) element.className = className; return element; };

function notice(message, kind = '') {
  $('notice').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message;
}
function page(name) {
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.page === name);
  for (const p of ['rules', 'connection', 'history']) $(`${p}-page`).hidden = p !== name;
  $('breadcrumb').textContent = `工作空间 / ${{ rules: '分流规则', connection: '连接设置', history: '恢复记录' }[name]}`;
  if (name === 'history') loadHistory();
}
function updateActions() {
  $('preview').disabled = busy || !client || (!entries.length && !client.entries.length) || !isDirty();
  $('add-rule').disabled = busy || !client;
  for (const element of document.querySelectorAll('#add-form input, #add-form select, #routes-list select, #routes-list button')) element.disabled = busy || !client;
  for (const id of ['refresh', 'discover', 'choose-config', 'choose-verge', 'choose-binary', 'quick-undo']) $(id).disabled = busy || (demo && id.startsWith('choose-'));
  for (const button of document.querySelectorAll('[data-connect], [data-restore]')) button.disabled = busy;
  $('apply').disabled = busy;
  $('close-preview').disabled = busy; $('cancel-preview').disabled = busy;
  $('apply-count').textContent = `${entries.length} 条`;
  $('rule-count').textContent = entries.length;
  $('nav-count').textContent = entries.length;
  $('draft-label').textContent = isDirty() ? '有未应用的改动' : entries.length ? (client?.verified ? '已核验生效' : '等待核验') : '暂无规则';
  $('apply-hint').textContent = busy ? '正在处理，请保持窗口开启。' : !client ? '先连接本地客户端并添加网站。' : !isDirty() ? (entries.length ? '当前规则已保存，可继续添加或编辑。' : '添加第一个网站，开始配置分流。') : !client.binary && !demo ? '请先在连接设置中选择校验内核。' : '先预览确认，再写入并立即生效。';
  $('empty-state').hidden = entries.length > 0; $('route-footer').hidden = entries.length === 0;
  const latest = history.find((h) => h.clientId === client?.id && h.status === 'committed');
  $('quick-undo').hidden = !latest;
}
async function task(fn, message) {
  if (busy) return;
  busy = true; updateActions();
  if (message) notice(message, 'pending');
  try { return await fn(); }
  catch (error) { notice(error.message, 'error'); await loadHistory().catch(() => {}); }
  finally { busy = false; updateActions(); }
}
function targetOptions(select, selected = '') {
  select.replaceChildren();
  if (!client) { select.append(new Option('连接客户端后选择', '')); return; }
  select.append(new Option('选择节点或策略组', ''));
  const group = document.createElement('optgroup'); group.label = '策略组';
  const nodes = document.createElement('optgroup'); nodes.label = '节点与其他出口';
  for (const target of client.targets) (target.group ? group : nodes).append(new Option(target.name === 'DIRECT' ? 'DIRECT · 直连' : target.name, target.name));
  if (group.children.length) select.append(group); if (nodes.children.length) select.append(nodes);
  if (selected && !client.targets.some((t) => t.name === selected)) select.append(new Option(`${selected}（已不可用）`, selected));
  select.value = selected;
}
function renderEntries() {
  $('routes-list').replaceChildren();
  entries.forEach((entry, index) => {
    const row = text('div', '', 'route-row');
    const domain = text('div', entry.domain, 'route-domain'); domain.append(text('small', entry.match === 'exact' ? '仅此域名' : '包含子域名'));
    const arrow = icon('arrow'); arrow.classList.add('route-arrow');
    const select = document.createElement('select'); select.setAttribute('aria-label', `${entry.domain} 的出口`); targetOptions(select, entry.target);
    select.addEventListener('change', () => { entries[index].target = select.value; plan = null; updateActions(); });
    const remove = text('button', '', 'icon-button'); remove.setAttribute('aria-label', `删除 ${entry.domain}`); remove.append(icon('trash'));
    remove.addEventListener('click', () => { entries.splice(index, 1); plan = null; renderEntries(); });
    row.append(domain, arrow, select, remove); $('routes-list').append(row);
  });
  updateActions();
}
function setClient(value) {
  client = value; entries = value.entries.map((e) => ({ ...e })); baseline = JSON.stringify(entries); plan = null;
  $('client-name').textContent = `${value.name} / ${value.profile}`;
  $('client-detail').textContent = `${value.targets.filter((t) => !t.group).length} 个节点及出口 · ${value.targets.filter((t) => t.group).length} 个策略组 · Mihomo ${value.version}`;
  $('client-badge').textContent = value.mode !== 'rule' ? '需切换规则模式' : value.verified ? '已连接' : '规则待核验';
  $('client-badge').className = `badge ${value.mode === 'rule' && value.verified ? 'good' : 'warning'}`;
  if (value.binary) $('binary-name').textContent = `已选择 ${value.binary}`;
  targetOptions($('target')); renderEntries();
}
async function loadHistory() { history = await bridge.history(); renderHistory(); updateActions(); }
function renderHistory() {
  const list = $('history-list'); list.replaceChildren();
  if (!history.length) { list.append(text('p', '尚无应用记录。首次应用前会自动创建备份。', 'history-empty')); return; }
  const labels = { committed: '已应用', 'rolled-back': '已自动恢复', undone: '已撤销', prepared: '操作中断', 'files-written': '等待恢复', 'recovery-needed': '需要恢复' };
  history.forEach((record) => {
    const row = text('div', '', 'history-row'); const info = document.createElement('div');
    info.append(text('strong', `${record.count} 条分流规则 · ${labels[record.status] || '状态未知'}`));
    info.append(text('p', `${new Date(record.createdAt).toLocaleString()}${record.clientId !== client?.id ? ' · 请连接对应配置后恢复' : ''}`));
    row.append(info);
    if (!['undone', 'rolled-back'].includes(record.status)) {
      const button = text('button', record.status === 'committed' ? '撤销这次应用' : '恢复中断操作', 'button secondary');
      button.dataset.restore = record.id;
      button.addEventListener('click', () => restore(record.id)); row.append(button);
    }
    list.append(row);
  });
}
function renderCandidates() {
  $('candidates').replaceChildren(); $('no-candidates').hidden = candidates.length > 0;
  for (const candidate of candidates) {
    const row = text('div', '', 'connection-row'); const info = document.createElement('div');
    info.append(text('strong', candidate.name)); info.append(text('p', candidate.error || `${candidate.profile} · ${candidate.root}`)); row.append(info);
    if (candidate.id) {
      const button = text('button', '连接', 'button secondary'); button.dataset.connect = candidate.id;
      button.addEventListener('click', () => task(async () => {
        if (!allowDiscard()) return;
        setClient(await bridge.connect(candidate.id)); page('rules'); notice('已连接本地客户端，节点和策略组已读取。', 'success'); await loadHistory();
      }, '正在连接本地客户端…')); row.append(button);
    }
    $('candidates').append(row);
  }
}
function allowDiscard() { return !isDirty() || window.confirm('当前有尚未应用的编辑。继续会丢弃这些编辑，是否继续？'); }
async function refresh() {
  if (!allowDiscard()) return;
  if (client) { setClient(await bridge.refresh()); await loadHistory(); notice('已重新读取当前配置和实际节点。', 'success'); }
  else await bootstrap();
}
async function bootstrap() {
  const result = await bridge.bootstrap(); candidates = result.candidates; demo = result.demo; history = result.history;
  $('demo-banner').hidden = !demo; $('version-label').textContent = `v${result.version} 预览版`;
  $('binary-name').textContent = demo ? '演示校验器（合成配置）' : result.binary ? `已找到 ${result.binary}` : '尚未找到 Mihomo 内核';
  renderCandidates(); renderHistory();
  const valid = candidates.filter((c) => c.id);
  const preferred = valid.find((c) => c.id === result.preferredId) || (valid.length === 1 ? valid[0] : null);
  if (preferred) {
    try { setClient(await bridge.connect(preferred.id)); }
    catch (error) { $('client-name').textContent = '找到客户端，但尚未连接'; $('client-detail').textContent = error.message; $('client-badge').textContent = '未连接'; $('client-badge').className = 'badge warning'; notice(error.message, 'error'); }
  } else {
    $('client-name').textContent = valid.length ? '选择需要管理的客户端' : '尚未找到本地客户端';
    $('client-detail').textContent = '打开连接设置，选择客户端数据目录或运行配置。';
    $('client-badge').textContent = '未连接'; $('client-badge').className = 'badge neutral';
  }
  if (history.some((h) => !['committed', 'rolled-back', 'undone'].includes(h.status))) notice('发现中断操作。请打开「恢复记录」完成恢复后再应用。', 'error');
  updateActions();
}

for (const item of document.querySelectorAll('.nav-item')) item.addEventListener('click', () => page(item.dataset.page));
$('open-connection').addEventListener('click', () => page('connection'));
$('refresh').addEventListener('click', () => task(refresh, '正在重新识别…'));
$('discover').addEventListener('click', () => task(async () => { if (allowDiscard()) await bootstrap(); }, '正在查找本地客户端…'));
for (const [id, operation] of [['choose-config', 'chooseConfig'], ['choose-verge', 'chooseVerge']]) $(id).addEventListener('click', () => task(async () => {
  if (!allowDiscard()) return; const result = await bridge[operation](); if (result) { setClient(result); page('rules'); notice('已连接所选配置。', 'success'); }
}));
$('choose-binary').addEventListener('click', () => task(async () => { const result = await bridge.chooseBinary(); if (result) { $('binary-name').textContent = `已选择 ${result}`; if (client) client.binary = result; notice('已选择校验内核。', 'success'); } }));
$('show-backups').addEventListener('click', () => task(() => bridge.showBackups()));
$('add-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (!client || busy) return;
  try {
    const input = $('website').value.trim(); const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用不含账号密码的 http / https 网址。');
    const domain = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!domain.includes('.') || /[,\s*]/.test(domain)) throw new Error('请输入完整域名；不支持通配符。');
    const match = $('match').value; const target = $('target').value;
    if (!target) throw new Error('请选择这个网站使用的出口。');
    if (entries.some((e) => e.domain === domain && e.match === match)) throw new Error('这条域名规则已经存在，可以直接修改下方出口。');
    if (entries.length >= 500) throw new Error('最多管理 500 条分流规则。');
    entries.push({ domain, match, target }); plan = null; renderEntries(); $('website').value = ''; $('website').focus();
    notice(`已添加 ${domain}，检查并应用后生效。`);
  } catch (error) { notice(error.message || '网址格式不正确。', 'error'); }
});
$('preview').addEventListener('click', () => task(async () => {
  plan = await bridge.preview(entries);
  $('preview-profile').textContent = `当前配置：${plan.profile} · ${plan.ruleCount} 条规则`;
  $('preview-rules').replaceChildren();
  for (const entry of plan.entries) { const row = text('div', '', 'preview-rule'); row.append(text('span', `${entry.domain}${entry.match === 'suffix' ? '（含子域名）' : ''}`), text('span', entry.target)); $('preview-rules').append(row); }
  if (!plan.entries.length) $('preview-rules').append(text('div', '移除本工具管理的全部规则，保留其他配置。', 'preview-rule'));
  $('preview-warnings').replaceChildren(...plan.warnings.map((w) => text('p', w)));
  $('preview-files').replaceChildren(text('div', plan.note), ...plan.files.map((f) => text('div', `${f.kind}：${f.name}`)));
  $('apply').textContent = plan.unchanged ? '核验当前配置' : '应用并生效';
  $('preview-dialog').showModal(); notice('配置已通过检查，请确认预览。');
}, '正在检查节点、配置语法与文件状态…'));
for (const id of ['close-preview', 'cancel-preview']) $(id).addEventListener('click', () => { if (!busy) { $('preview-dialog').close(); plan = null; } });
$('preview-dialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); else plan = null; });
$('apply').addEventListener('click', () => task(async () => {
  if (!plan) return;
  $('apply').textContent = '正在备份并应用…';
  const result = await bridge.apply(plan.id); $('preview-dialog').close(); plan = null;
  setClient(await bridge.refresh()); await loadHistory();
  notice(result.status === 'unchanged' ? '配置未变化，已重新核验当前规则。' : `已应用 ${result.count} 条规则，并确认内核加载成功。原配置已备份。`, 'success');
}, '正在备份、写入和核验配置…').then(() => { $('preview-dialog').close(); plan = null; $('apply').textContent = '应用并生效'; }));
async function restore(id) {
  if (!allowDiscard()) return;
  if (!window.confirm('将恢复这次应用前的文件并重载内核。若配置已有后续修改，工具会停止恢复。是否继续？')) return;
  await task(async () => { await bridge.restore(id); setClient(await bridge.refresh()); await loadHistory(); notice('已恢复原文件，并确认原规则重新加载。', 'success'); }, '正在检查备份并恢复原配置…');
}
$('quick-undo').addEventListener('click', () => { const record = history.find((h) => h.clientId === client?.id && h.status === 'committed'); if (record) restore(record.id); });

// Check subscription changes while idle, without overwriting edits in progress.
setInterval(async () => {
  if (busy || !client || isDirty() || $('preview-dialog').open) return;
  try {
    const next = await bridge.refresh();
    if (next.id !== client.id) notice('客户端已切换订阅，已显示新订阅的分流配置。');
    else if (!next.verified) notice('已保存的分流规则当前未生效，请检查规则模式、出口及客户端扩展脚本。', 'error');
    setClient(next);
  } catch { $('client-badge').textContent = '连接中断'; $('client-badge').className = 'badge warning'; }
}, 15000);

task(bootstrap).catch((error) => notice(error.message, 'error'));
