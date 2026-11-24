// Runs the packaged-app E2E spec against release/win-unpacked.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = path.resolve('release', 'win-unpacked', 'Weakword Coach.exe');
if (!existsSync(exe)) {
  console.error(`Missing ${exe}. Run "npm run dist" first.`);
  process.exit(1);
}
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const r = spawnSync('npx', ['playwright', 'test', 'test/e2e/packaged.spec.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...env, WWC_EXE: exe },
});
process.exit(r.status ?? 1);
