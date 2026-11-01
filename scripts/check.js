import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
for (const file of ['src','scripts','test','public'].flatMap(walk).filter(f => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(1);
}
console.log('Syntax checks passed.');
