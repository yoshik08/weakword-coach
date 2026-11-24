import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const cjs = { ...common, platform: 'node', format: 'cjs', external: ['electron'] };

await Promise.all([
  // better-sqlite3 loads a native .node file, so it stays a runtime require.
  build({ ...cjs, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', external: ['electron', 'better-sqlite3'] }),
  // Preloads run sandboxed, so each must be one self-contained file.
  build({ ...cjs, entryPoints: ['src/preload/monkeytype.ts'], outfile: 'dist/preload/monkeytype.js' }),
  build({ ...cjs, entryPoints: ['src/preload/coach.ts'], outfile: 'dist/preload/coach.js' }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: ['src/coach/coach.ts'], outfile: 'dist/coach/coach.js' }),
]);

mkdirSync('dist/coach', { recursive: true });
for (const f of ['index.html', 'coach.css']) cpSync(`src/coach/${f}`, `dist/coach/${f}`);
