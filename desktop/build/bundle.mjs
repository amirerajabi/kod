// Bundles the main process and the preload into out/ (electron stays external).
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'out/main.js' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'out/preload.js' });
