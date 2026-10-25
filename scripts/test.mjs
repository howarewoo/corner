import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

// The server workspace runs this native runner from its package directory.
const root = process.cwd();
const files = readdirSync(resolve(root, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('tests', name));
function collect(directory) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (directory.split('/').includes('__tests__') && entry.name.endsWith('.test.ts'))
      files.push(relative(root, resolve(root, path)));
  }
}
collect('src');
files.sort();
let failed = 0;
// Separate processes keep each suite's database hooks private.
// No inner isolation preserves individually named test output in this runtime.
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-isolation=none', file],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  if (result.status !== 0 || result.error) failed++;
}
process.stdout.write(`\n${files.length - failed}/${files.length} test files passed.\n`);
process.exitCode = failed ? 1 : 0;
