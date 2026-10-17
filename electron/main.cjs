const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const demo = !app.isPackaged && (process.argv.includes('--demo') || process.argv.includes('--ui-smoke'));
const smoke = !app.isPackaged && process.argv.includes('--ui-smoke');
let window, selected, service, binary, candidates = [], sandbox, quitting = false;
const uiFile = path.join(__dirname, '../ui/index.html');
const uiURL = pathToFileURL(uiFile).href;

if (demo) app.setPath('userData', path.join(__dirname, `../.artifacts/demo-${process.pid}`));
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });

async function start() {
  const adapters = await import('../src/adapters.mjs');
  const { RoutingService } = await import('../src/service.mjs');
  const { UserError } = await import('../src/rules.mjs');
  const { writeJSON, readJSON, snapshot } = await import('../src/files.mjs');
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const settings = demo ? {} : await readJSON(settingsFile, {});
  if (demo) {
    const { createSandbox } = await import('../src/sandbox.mjs');
    sandbox = await createSandbox(path.join(app.getPath('userData'), 'client'));
  }
  const roots = demo ? [sandbox.root] : adapters.defaultRoots();
  if (!demo && typeof settings.vergeRoot === 'string' && !roots.includes(settings.vergeRoot)) roots.push(settings.vergeRoot);
  service = new RoutingService(app.getPath('userData'), demo ? { validate: async () => {} } : {});
  binary = demo ? null : (settings.binary || await adapters.defaultBinary());
  const saveSettings = () => demo ? Promise.resolve() : writeJSON(settingsFile, settings);
  const requireSelected = () => { if (!selected) throw new UserError('请先连接一个本地客户端。'); return selected; };

  const status = async () => {
    const previous = requireSelected();
    selected = await adapters.reopen(previous);
    if (previous.id !== selected.id) service.plans.clear();
    const live = await adapters.liveStatus(selected);
    let verified = true;
    try {
      const { assertRules } = await import('../src/api.mjs');
      const { ruleLines } = await import('../src/rules.mjs');
      assertRules(live.status.rules, ruleLines(selected.managed));
      verified = live.status.config.mode === 'rule';
    } catch { verified = false; }
    return { id: selected.id, kind: selected.kind, name: selected.kind === 'verge' ? 'Clash Verge Rev' : 'Mihomo',
      profile: selected.profile, root: selected.root, entries: selected.managed, targets: live.targets,
      version: live.status.version, mode: live.status.config.mode, verified,
      binary: binary ? path.basename(binary) : null, demo,
    };
  };

  function handle(name, fn) {
    ipcMain.handle(`routing:${name}`, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiURL) return { ok: false, message: '操作来源无效。', code: 'ORIGIN' };
      try { return { ok: true, value: await fn(...args) }; }
      catch (error) {
        return { ok: false, message: error instanceof UserError ? error.message : '本地操作失败，请检查文件权限、客户端状态或备份记录。', code: error instanceof UserError ? error.code : 'LOCAL' };
      }
    });
  }
  handle('bootstrap', async () => {
    candidates = await adapters.discover(roots);
    if (!demo && settings.configFile) {
      try { const saved = await adapters.openStandalone(settings.configFile); candidates.push({ kind: 'standalone', file: saved.file, id: saved.id, name: 'Mihomo', profile: saved.profile, root: saved.root }); } catch { /* File may have moved; manual selection remains available. */ }
    }
    return { candidates, preferredId: settings.lastClient, demo, version: app.getVersion(), binary: binary ? path.basename(binary) : null, history: await service.history() };
  });
  handle('connect', async (id) => {
    if (service.busy) throw new UserError('正在应用配置，请等待完成。');
    const candidate = candidates.find((c) => c.id === id);
    if (!candidate) throw new UserError('未找到客户端，请重新识别。');
    selected = candidate.kind === 'standalone' ? await adapters.openStandalone(candidate.file) : await adapters.openVerge(candidate.root);
    settings.lastClient = selected.id; await saveSettings();
    service.plans.clear(); return status();
  });
  handle('choose-config', async () => {
    if (demo || service.busy) throw new UserError('当前模式不能选择真实配置。');
    const result = await dialog.showOpenDialog(window, { title: '选择正在运行的 Mihomo 配置文件', properties: ['openFile'], filters: [{ name: 'YAML 配置', extensions: ['yaml', 'yml'] }] });
    if (result.canceled) return null;
    selected = await adapters.openStandalone(result.filePaths[0]);
    service.plans.clear(); settings.configFile = result.filePaths[0]; settings.lastClient = selected.id; await saveSettings(); return status();
  });
  handle('choose-verge', async () => {
    if (demo || service.busy) throw new UserError('当前模式不能选择真实配置。');
    const result = await dialog.showOpenDialog(window, { title: '选择含 profiles.yaml 的 Clash Verge Rev 数据目录', properties: ['openDirectory'] });
    if (result.canceled) return null;
    selected = await adapters.openVerge(result.filePaths[0]);
    service.plans.clear(); settings.vergeRoot = selected.root; settings.lastClient = selected.id; await saveSettings(); return status();
  });
  handle('choose-binary', async () => {
    if (demo || service.busy) throw new UserError('当前模式不能选择内核。');
    const result = await dialog.showOpenDialog(window, { title: '选择 Mihomo 可执行程序（mihomo / verge-mihomo）', properties: ['openFile'] });
    if (result.canceled) return null;
    const stat = await fs.lstat(result.filePaths[0]);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new UserError('请选择实际的内核可执行文件。');
    binary = result.filePaths[0]; settings.binary = binary; await saveSettings(); return path.basename(binary);
  });
  handle('refresh', status);
  handle('preview', (entries) => service.preview(requireSelected(), entries, binary));
  handle('apply', async (id) => {
    if (typeof id !== 'string') throw new UserError('预览无效。');
    return service.apply(id);
  });
  handle('history', () => service.history());
  handle('restore', async (id) => service.restore(id, requireSelected()));
  handle('show-backups', async () => {
    const folder = path.join(app.getPath('userData'), 'backups');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(folder);
    if (error) throw new UserError('无法打开备份文件夹。');
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Node Switcher', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
  window = new BrowserWindow({ width: 1250, height: 850, minWidth: 900, minHeight: 680,
    title: 'Node Switcher', backgroundColor: '#f4f6fa', show: !smoke,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(pathToFileURL(path.join(__dirname, '../ui/')).href);
    callback({ cancel: !allowed });
  });
  window.on('close', (event) => {
    if (service.busy && !quitting) { event.preventDefault(); dialog.showMessageBox(window, { type: 'info', message: '正在处理配置，请等待完成后再关闭。' }); }
  });
  await window.loadFile(uiFile);
  if (smoke) {
    try { await require('./ui-smoke.cjs').run(window, path.join(__dirname, '../.artifacts/ui')); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { quitting = true; await sandbox?.close(); app.exit(process.exitCode || 0); }
  }
}

app.on('before-quit', (event) => { if (service?.busy && !quitting) { event.preventDefault(); window?.show(); } });
app.on('window-all-closed', async () => { await sandbox?.close(); app.quit(); });
app.on('activate', () => { window?.show(); });
if (ownsLock) app.whenReady().then(start).catch(async () => {
  await dialog.showMessageBox({ type: 'error', message: '启动失败，请检查本地数据目录权限。' }); app.exit(1);
});
