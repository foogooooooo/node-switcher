import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [];
async function visit(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) files.push(file);
  }
}
for (const dir of ['src', 'ui', 'electron', 'test', 'scripts']) await visit(dir);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log(`Syntax checks passed (${files.length} files).`);
