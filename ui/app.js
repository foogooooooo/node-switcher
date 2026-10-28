/* The renderer never reads configuration files or receives node credentials. */
const $ = (id) => document.getElementById(id);
const bridge = window.routing;
let client = null, entries = [], baseline = '[]', history = [], candidates = [], busy = false, plan = null, demo = false;
let connected = false, removed = null, setupAction = 'connection', editVersion = 0;
const isDirty = () => JSON.stringify(entries) !== baseline;
const hasInput = () => Boolean($('website').value.trim());
const invalidate = () => { plan = null; editVersion++; };
const key = (entry) => `${entry.match}:${entry.domain}`;
function changes() {
  const before = new Map(JSON.parse(baseline).map((e) => [key(e), e.target]));
  const after = new Map(entries.map((e) => [key(e), e.target]));
  const added = entries.filter((e) => !before.has(key(e))).length;
  const edited = entries.filter((e) => before.has(key(e)) && before.get(key(e)) !== e.target).length;
  const deleted = [...before.keys()].filter((k) => !after.has(k)).length;
  return [[added, '新增'], [edited, '修改'], [deleted, '删除']].filter(([n]) => n).map(([n, label]) => `${label} ${n} 个`).join(' · ');
}
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
  $('client-badge').textContent = !connected ? (client ? '连接中断' : '未连接') : client.mode !== 'rule' ? '需切换规则模式' : client.verified ? '已连接' : '规则待核验';
  $('client-badge').className = `badge ${connected && client?.mode === 'rule' && client.verified ? 'good' : client ? 'warning' : 'neutral'}`;
  if (!client) { $('client-name').textContent = '尚未连接本地客户端'; $('client-detail').textContent = '打开客户端，或进入连接设置手动选择。'; }
  const pending = history.some((h) => h.clientId === client?.id && !['committed', 'rolled-back', 'undone'].includes(h.status));
  const ready = connected && client?.mode === 'rule' && (client?.binary || demo) && !pending;
  $('preview').disabled = busy || !ready || !isDirty();
  $('add-rule').disabled = busy || !connected;
  for (const element of document.querySelectorAll('#add-form input, #add-form select, #routes-list select, #routes-list button')) element.disabled = busy || !connected;
  for (const id of ['refresh', 'discover', 'choose-config', 'choose-verge', 'choose-binary', 'quick-undo']) $(id).disabled = busy || (demo && id.startsWith('choose-'));
  for (const button of document.querySelectorAll('[data-connect], [data-restore]')) button.disabled = busy;
  $('apply').disabled = busy;
  $('close-preview').disabled = busy; $('cancel-preview').disabled = busy;
  $('discard-draft').hidden = !isDirty(); $('discard-draft').disabled = busy;
  $('undo-remove').disabled = busy; $('remove-feedback').hidden = !removed;
  $('setup-action').disabled = busy;
  $('apply-count').textContent = `${entries.length} 条`;
  $('rule-count').textContent = entries.length;
  $('nav-count').textContent = entries.length;
  $('draft-label').textContent = isDirty() ? '尚未生效' : entries.length ? (connected && client?.verified ? '已生效' : '等待核验') : '暂无网站';
  $('draft-label').className = isDirty() ? 'draft-pending' : 'muted';
  $('apply-heading').textContent = isDirty() ? changes() : entries.length ? (connected && client?.verified ? '分流已生效' : '等待检查分流状态') : '添加网站后，在这里保存';
  $('apply-hint').textContent = busy ? '正在处理，请稍候…' : hasInput() ? '上方还有一个网站未加入列表，请先加入或清空。' : !connected ? '连接客户端后，即可选择出口。' : !ready ? '请先完成上方提示，再保存分流。' : !isDirty() ? (entries.length ? '可以继续添加网站，或直接更换列表里的出口。' : '先输入网址，再选择它要使用的出口。') : '保存前会检查并备份，下一步可确认全部网站。';
  const needsHelp = !connected || !ready || (entries.length > 0 && !client.verified);
  $('setup-help').hidden = !needsHelp;
  let title, description, action;
  if (!connected) {
    title = client ? '客户端连接中断' : '先连接你的代理客户端';
    description = '打开 Clash Verge Rev 并保持运行，再点击重新查找；自定义安装可以到连接设置手动选择。';
    action = candidates.filter((c) => c.id).length > 1 ? '选择客户端' : '重新查找'; setupAction = action === '选择客户端' ? 'connection' : 'refresh';
  } else if (pending) {
    title = '上一次操作尚未完成'; description = '先恢复中断操作，再继续设置网站分流。'; action = '去恢复'; setupAction = 'history';
  } else if (client.mode !== 'rule') {
    title = '请先把代理客户端切到「规则模式」'; description = '当前模式不会按网站分流。切换后点击右侧按钮检查。'; action = '我已切换，重新检查'; setupAction = 'refresh';
  } else if (!client.binary && !demo) {
    title = '还需选择本机 Mihomo 内核'; description = '用于保存前检查配置。只需选一次，之后会自动记住。'; action = '选择内核'; setupAction = 'binary';
  } else {
    title = '已保存的分流暂未核验生效'; description = '请检查客户端的规则模式和扩展脚本，再刷新连接。'; action = '刷新检查'; setupAction = 'refresh';
  }
  $('setup-title').textContent = title; $('setup-description').textContent = description; $('setup-action').textContent = action;
  for (const [id, done, active] of [['step-connect', connected, !connected], ['step-edit', entries.length > 0, connected && !entries.length], ['step-apply', connected && entries.length > 0 && client?.verified && !isDirty(), connected && isDirty()]]) {
    $(id).classList.toggle('done', Boolean(done)); $(id).classList.toggle('current', Boolean(active));
  }
  $('empty-state').hidden = entries.length > 0; $('route-footer').hidden = entries.length === 0;
  const latest = history.find((h) => h.clientId === client?.id && h.status === 'committed');
  $('quick-undo').hidden = !latest; $('quick-undo').disabled = busy || !connected;
}
async function task(fn, message) {
  if (busy) return;
  busy = true; updateActions();
  if (message) notice(message, 'pending');
  try { return await fn(); }
  catch (error) { notice(error.message, 'error'); await loadHistory().catch(() => {}); }
  finally { busy = false; updateActions(); }
}
function targetOptions(select, selected = '', query = '') {
  select.replaceChildren();
  if (!client) { select.append(new Option('连接客户端后选择', '')); return; }
  select.append(new Option('选择节点或策略组', ''));
  const group = document.createElement('optgroup'); group.label = '策略组';
  const nodes = document.createElement('optgroup'); nodes.label = '节点与其他出口';
  const label = (name) => name === 'DIRECT' ? '直连（不走代理）' : name === 'REJECT' ? '阻止访问' : name;
  const filtered = client.targets.filter((t) => `${t.name} ${label(t.name)}`.toLowerCase().includes(query.trim().toLowerCase()));
  // Keep the user's explicit selection even when the filter excludes it.
  for (const target of client.targets.filter((t) => filtered.includes(t) || t.name === selected)) (target.group ? group : nodes).append(new Option(label(target.name), target.name));
  if (group.children.length) select.append(group); if (nodes.children.length) select.append(nodes);
  if (selected && !client.targets.some((t) => t.name === selected)) select.append(new Option(`${selected}（已不可用）`, selected));
  select.value = selected;
  if (select.id === 'target') $('target-help').textContent = query ? `找到 ${filtered.length} 个匹配出口${selected ? '，保留已选出口' : ''}。` : '可以选择节点、策略组或直连。';
}
function renderEntries() {
  $('routes-list').replaceChildren();
  entries.forEach((entry, index) => {
    const row = text('div', '', 'route-row');
    const domain = text('div', entry.domain, 'route-domain'); domain.append(text('small', entry.match === 'exact' ? '仅此域名' : '包含子域名'));
    const arrow = icon('arrow'); arrow.classList.add('route-arrow');
    const select = document.createElement('select'); select.setAttribute('aria-label', `${entry.domain} 的出口`); targetOptions(select, entry.target);
    select.addEventListener('change', () => { entries[index].target = select.value; invalidate(); updateActions(); });
    const remove = text('button', '', 'icon-button'); remove.setAttribute('aria-label', `删除 ${entry.domain}`); remove.append(icon('trash'));
    remove.addEventListener('click', () => { removed = { entry: { ...entries[index] }, index }; entries.splice(index, 1); $('remove-message').textContent = `已从列表移除 ${removed.entry.domain}`; invalidate(); renderEntries(); });
    row.append(domain, arrow, select, remove); $('routes-list').append(row);
  });
  updateActions();
}
function setClient(value) {
  const same = client?.id === value.id;
  const selection = same ? $('target').value : '';
  client = value; connected = true; entries = value.entries.map((e) => ({ ...e })); baseline = JSON.stringify(entries); invalidate(); removed = null;
  if (!same) { $('website').value = ''; $('target-search').value = ''; $('match').value = 'suffix'; $('match-summary').textContent = '包含子域名'; $('match-options').open = false; }
  formError('');
  $('client-name').textContent = `${value.name} / ${value.profile}`;
  $('client-detail').textContent = `已读取 ${value.targets.length} 个可选出口 · 只在本机处理`;
  if (value.binary) $('binary-name').textContent = `已选择 ${value.binary}`;
  targetOptions($('target'), value.targets.some((t) => t.name === selection) ? selection : '', $('target-search').value); renderEntries();
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
        connected = false; invalidate();
        setClient(await bridge.connect(candidate.id)); page('rules'); notice('已连接本地客户端，节点和策略组已读取。', 'success'); await loadHistory();
      }, '正在连接本地客户端…')); row.append(button);
    }
    $('candidates').append(row);
  }
}
function allowDiscard() { return (!isDirty() && !hasInput()) || window.confirm('当前有尚未保存的网站或改动。继续会丢弃这些编辑，是否继续？'); }
async function refresh() {
  if (!allowDiscard()) return;
  if (client) {
    try { setClient(await bridge.refresh()); await loadHistory(); notice('已刷新连接与出口列表。', 'success'); }
    catch (error) { connected = false; $('client-badge').textContent = '连接中断'; $('client-badge').className = 'badge warning'; throw error; }
  }
  else await bootstrap();
}
async function bootstrap() {
  notice('正在查找本地客户端…', 'pending');
  const result = await bridge.bootstrap(); candidates = result.candidates; demo = result.demo; history = result.history;
  client = null; connected = false; entries = []; baseline = '[]'; removed = null; invalidate();
  $('website').value = ''; $('target-search').value = ''; targetOptions($('target')); renderEntries();
  $('demo-banner').hidden = !demo; $('version-label').textContent = `v${result.version} 预览版`;
  $('binary-name').textContent = demo ? '演示校验器（合成配置）' : result.binary ? `已找到 ${result.binary}` : '尚未找到 Mihomo 内核';
  renderCandidates(); renderHistory();
  const valid = candidates.filter((c) => c.id);
  const preferred = valid.find((c) => c.id === result.preferredId) || (valid.length === 1 ? valid[0] : null);
  if (preferred) {
    try { setClient(await bridge.connect(preferred.id)); notice(''); }
    catch (error) { $('client-name').textContent = '找到客户端，但尚未连接'; $('client-detail').textContent = error.message; $('client-badge').textContent = '未连接'; $('client-badge').className = 'badge warning'; notice(error.message, 'error'); }
  } else {
    $('client-name').textContent = valid.length ? '选择需要管理的客户端' : '尚未找到本地客户端';
    $('client-detail').textContent = '打开连接设置，选择客户端数据目录或运行配置。';
    $('client-badge').textContent = '未连接'; $('client-badge').className = 'badge neutral';
    notice('');
  }
  if (history.some((h) => !['committed', 'rolled-back', 'undone'].includes(h.status))) notice('发现中断操作。请打开「恢复记录」完成恢复后再应用。', 'error');
  updateActions();
}

for (const item of document.querySelectorAll('.nav-item')) item.addEventListener('click', () => page(item.dataset.page));
$('open-connection').addEventListener('click', () => page('connection'));
$('setup-action').addEventListener('click', () => {
  if (setupAction === 'refresh') $('refresh').click();
  else if (setupAction === 'binary') $('choose-binary').click();
  else page(setupAction);
});
$('refresh').addEventListener('click', () => task(refresh, '正在重新识别…'));
$('discover').addEventListener('click', () => task(async () => { if (allowDiscard()) await bootstrap(); }, '正在查找本地客户端…'));
for (const [id, operation] of [['choose-config', 'chooseConfig'], ['choose-verge', 'chooseVerge']]) $(id).addEventListener('click', () => task(async () => {
  if (!allowDiscard()) return;
  let result;
  try { result = await bridge[operation](); }
  catch (error) { connected = false; invalidate(); throw error; }
  if (result) { setClient(result); page('rules'); notice('已连接所选配置。', 'success'); }
}));
$('choose-binary').addEventListener('click', () => task(async () => { const result = await bridge.chooseBinary(); if (result) { $('binary-name').textContent = `已选择 ${result}`; if (client) client.binary = result; notice('已选择校验内核。', 'success'); } }));
$('show-backups').addEventListener('click', () => task(() => bridge.showBackups()));
function formError(message, field = 'website') {
  $('form-error').textContent = message; $('form-error').hidden = !message;
  $('website').removeAttribute('aria-invalid'); $('target').removeAttribute('aria-invalid');
  if (message) { $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); }
}
function inputDomain(input) {
  let url;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); }
  catch { throw new Error('网址格式不正确，例如 example.com 或 https://example.com。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用不含账号密码的 http / https 网址。');
  const domain = url.hostname.toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.split('.').length < 2 || domain.split('.').some((s) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) throw new Error('请填写完整域名；暂不支持 IP、通配符或本地主机名。');
  return domain;
}
$('website').addEventListener('input', () => {
  formError(''); editVersion++;
  try { $('website-help').textContent = `将添加：${inputDomain($('website').value.trim())}`; }
  catch { $('website-help').textContent = '支持完整网址，自动提取域名。'; }
  updateActions();
});
$('match').addEventListener('change', () => { editVersion++; $('match-summary').textContent = $('match').value === 'exact' ? '仅这个域名' : '包含子域名'; });
$('target').addEventListener('change', () => { editVersion++; formError(''); });
$('target-search').addEventListener('input', () => { editVersion++; targetOptions($('target'), $('target').value, $('target-search').value); });
$('target-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('target').focus(); } });
$('discard-draft').addEventListener('click', () => {
  if (busy || !window.confirm('放弃列表中尚未保存的改动？已生效的分流保持不变。')) return;
  entries = JSON.parse(baseline); removed = null; invalidate(); renderEntries(); notice('已放弃列表改动。');
});
$('undo-remove').addEventListener('click', () => {
  if (busy || !removed) return;
  if (entries.some((e) => key(e) === key(removed.entry))) { notice('该网站已重新加入列表，无需重复恢复。'); return; }
  if (entries.length >= 500) { notice('列表已达 500 条，请先移除一条再撤销删除。', 'error'); return; }
  entries.splice(Math.min(removed.index, entries.length), 0, removed.entry); removed = null; invalidate(); renderEntries();
});
$('add-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (!client || !connected || busy) return;
  try {
    const domain = inputDomain($('website').value.trim());
    const match = $('match').value; const target = $('target').value;
    if (!target) throw new Error('请选择这个网站使用的出口。');
    if (entries.some((e) => e.domain === domain && e.match === match)) throw new Error('这条域名规则已经存在，可以直接修改下方出口。');
    if (entries.length >= 500) throw new Error('最多管理 500 条分流规则。');
    entries.push({ domain, match, target }); invalidate(); $('website').value = ''; $('website-help').textContent = '支持完整网址，自动提取域名。';
    // Each new website starts with the visible, documented default scope.
    $('match').value = 'suffix'; $('match-summary').textContent = '包含子域名'; $('match-options').open = false;
    formError(''); renderEntries(); $('website').focus(); notice('');
  } catch (error) { formError(error.message || '网址格式不正确。', !$('target').value ? 'target' : 'website'); }
});
$('preview').addEventListener('click', () => task(async () => {
  if (hasInput()) { formError('这个网站还没有加入列表。请先点击「加入列表」，或清空后保存。'); notice(''); return; }
  plan = await bridge.preview(entries);
  $('preview-title').textContent = plan.entries.length ? '让这些网站走你选的出口' : '移除全部自定义网站分流';
  $('preview-changes').textContent = changes(); $('preview-details').open = false;
  $('preview-profile').textContent = `当前配置：${plan.profile} · ${plan.ruleCount} 条规则`;
  $('preview-rules').replaceChildren();
  for (const entry of plan.entries) { const row = text('div', '', 'preview-rule'); row.append(text('span', `${entry.domain}${entry.match === 'suffix' ? '（含子域名）' : ''}`), text('span', entry.target)); $('preview-rules').append(row); }
  if (!plan.entries.length) $('preview-rules').append(text('div', '移除本工具管理的全部规则，保留其他配置。', 'preview-rule'));
  $('preview-warnings').replaceChildren(...plan.warnings.map((w) => text('p', w)));
  $('preview-files').replaceChildren(text('div', plan.note), ...plan.files.map((f) => text('div', `${f.kind}：${f.name}`)));
  $('apply').textContent = plan.unchanged ? '核验当前配置' : '确认生效';
  $('preview-dialog').showModal(); notice('');
}, '正在检查节点、配置语法与文件状态…'));
for (const id of ['close-preview', 'cancel-preview']) $(id).addEventListener('click', () => { if (!busy) { $('preview-dialog').close(); plan = null; } });
$('preview-dialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); else plan = null; });
$('apply').addEventListener('click', () => task(async () => {
  if (!plan) return;
  $('apply').textContent = '正在备份并应用…';
  const result = await bridge.apply(plan.id); $('preview-dialog').close(); plan = null;
  setClient(await bridge.refresh()); await loadHistory();
  notice(result.status === 'unchanged' ? '配置未变化，已重新核验当前规则。' : `已应用 ${result.count} 条规则，并确认内核加载成功。原配置已备份。`, 'success');
}, '正在备份、写入和核验配置…').then(() => { $('preview-dialog').close(); plan = null; $('apply').textContent = '确认生效'; }));
async function restore(id) {
  if (!allowDiscard()) return;
  if (!window.confirm('将恢复这次应用前的文件并重载内核。若配置已有后续修改，工具会停止恢复。是否继续？')) return;
  await task(async () => { await bridge.restore(id); setClient(await bridge.refresh()); await loadHistory(); notice('已恢复原文件，并确认原规则重新加载。', 'success'); }, '正在检查备份并恢复原配置…');
}
$('quick-undo').addEventListener('click', () => { const record = history.find((h) => h.clientId === client?.id && h.status === 'committed'); if (record) restore(record.id); });

// Check subscription changes while idle, without overwriting edits in progress.
async function refreshIfIdle() {
  if (busy || !client || isDirty() || hasInput() || $('preview-dialog').open) return;
  const version = editVersion;
  try {
    const next = await bridge.refresh();
    if (busy || editVersion !== version || isDirty() || hasInput() || $('preview-dialog').open) return;
    if (next.id !== client.id) notice('客户端已切换订阅，已显示新订阅的分流配置。');
    else if (!next.verified) notice('已保存的分流规则当前未生效，请检查规则模式、出口及客户端扩展脚本。', 'error');
    setClient(next);
  } catch {
    if (busy || editVersion !== version) return;
    connected = false; $('client-badge').textContent = '连接中断'; $('client-badge').className = 'badge warning'; updateActions();
  }
}
setInterval(refreshIfIdle, 15000);

task(bootstrap).catch((error) => notice(error.message, 'error'));
