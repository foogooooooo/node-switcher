const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');

exports.run = async (window, directory) => {
  await fs.mkdir(directory, { recursive: true });
  const evaluate = (code) => window.webContents.executeJavaScript(code, true);
  const errors = [];
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  async function waitFor(code) {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (await evaluate(code)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`UI timed out: ${code}`);
  }
  async function screenshot(name) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const image = await window.webContents.capturePage(); await fs.writeFile(path.join(directory, name), image.toPNG());
  }
  await waitFor(`document.getElementById('client-badge').textContent === '已连接'`);
  await screenshot('01-empty.png');
  await evaluate(`document.getElementById('website').value = 'https://example.com/path'; document.getElementById('target').value = '日本 · 测试节点'; document.getElementById('add-form').requestSubmit();`);
  await waitFor(`document.querySelectorAll('.route-row').length === 1`);
  await evaluate(`document.getElementById('website').value = 'news.example.com'; document.getElementById('match').value = 'exact'; document.getElementById('target').value = '美国 · 测试节点'; document.getElementById('add-form').requestSubmit();`);
  await waitFor(`document.querySelectorAll('.route-row').length === 2`);
  assert.equal(await evaluate(`document.getElementById('preview').getBoundingClientRect().bottom < window.innerHeight`), true, 'Main action must stay visible');
  await screenshot('02-rules.png');
  await evaluate(`document.getElementById('preview').click()`);
  await waitFor(`document.getElementById('preview-dialog').open`);
  await screenshot('03-preview.png');
  assert.match(await evaluate(`document.getElementById('preview-warnings').textContent`), /优先/);
  await evaluate(`document.getElementById('apply').click()`);
  await waitFor(`!document.getElementById('preview-dialog').open && document.getElementById('notice').textContent.includes('已应用 2 条')`);
  await screenshot('04-applied.png');
  const result = await evaluate(`window.routing.refresh()`);
  assert.equal(result.entries.length, 2); assert.equal(result.verified, true);
  await evaluate(`document.querySelector('[data-page="history"]').click()`);
  await waitFor(`document.querySelector('[data-restore]') !== null`);
  await screenshot('05-history.png');
  await evaluate(`window.confirm = () => true; document.querySelector('[data-restore]').click()`);
  await waitFor(`document.getElementById('notice').textContent.includes('已恢复原文件')`);
  assert.equal((await evaluate(`window.routing.refresh()`)).entries.length, 0);
  await evaluate(`document.querySelector('[data-page="connection"]').click()`);
  await screenshot('06-connection.png');
  window.setSize(920, 760);
  await evaluate(`document.querySelector('[data-page="rules"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await evaluate(`document.documentElement.scrollWidth > window.innerWidth`), false, 'Window must not overflow horizontally');
  await screenshot('07-narrow.png');
  assert.deepEqual(errors, []);
  console.log('Electron UI smoke passed: synthetic connection, edit, preview, apply, verified readback, undo, narrow window.');
};
