import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { packager } from '@electron/packager';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'release');
await fs.mkdir(path.join(root, '.artifacts'), { recursive: true });
const stage = await fs.mkdtemp(path.join(root, '.artifacts/package-'));
try {
  await fs.mkdir(path.join(stage, 'electron'));
  for (const name of ['main.cjs', 'preload.cjs']) await fs.copyFile(path.join(root, 'electron', name), path.join(stage, 'electron', name));
  await fs.cp(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true, filter: (file) => !file.endsWith('sandbox.mjs') });
  await fs.cp(path.join(root, 'ui'), path.join(stage, 'ui'), { recursive: true });
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'Node Switcher', version: pkg.version, main: pkg.main, type: pkg.type, license: pkg.license, dependencies: pkg.dependencies }));
  await fs.mkdir(path.join(stage, 'node_modules'));
  for (const name of Object.keys(pkg.dependencies)) await fs.cp(path.dirname(require.resolve(`${name}/package.json`)), path.join(stage, 'node_modules', name), { recursive: true });
  const [result] = await packager({ dir: stage, name: 'Node Switcher', out: output, overwrite: true,
    platform: process.platform, arch: process.arch, electronVersion: pkg.devDependencies.electron,
    appBundleId: 'io.github.foogooooooo.node-switcher', appCategoryType: 'public.app-category.utilities',
    appVersion: pkg.version, buildVersion: pkg.version, asar: true, prune: false,
  });
  console.log(`Packaged: ${result}`);
  if (process.platform === 'darwin') {
    const application = path.join(result, 'Node Switcher.app');
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application]);
    if (process.argv.includes('--zip')) {
      const zip = path.join(output, `NodeSwitcher-${pkg.version}-mac-${process.arch}.zip`);
      await execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, zip]);
      const digest = createHash('sha256').update(await fs.readFile(zip)).digest('hex');
      await fs.writeFile(`${zip}.sha256`, `${digest}  ${path.basename(zip)}\n`);
      console.log(`ZIP: ${zip}`);
    }
  } else if (process.argv.includes('--zip')) throw new Error('dist:mac must run on macOS.');
} finally { await fs.rm(stage, { recursive: true, force: true }); }
