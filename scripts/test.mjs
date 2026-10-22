import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// npm runs each workspace script from its package directory.
const root = process.cwd();
const files = readdirSync(resolve(root, 'tests')).filter(name => name.endsWith('.test.ts')).sort();
let failed = 0;
// Separate processes keep each suite's database hooks and browser mocks private.
// No inner isolation preserves individually named test output in this runtime.
for (const file of files) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-isolation=none', `tests/${file}`], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0 || result.error) failed++;
}
process.stdout.write(`\n${files.length - failed}/${files.length} test files passed.\n`);
process.exitCode = failed ? 1 : 0;
