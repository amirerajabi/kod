// The app version lives in three places (desktop/package.json is the one electron-builder and the updater use);
// they must agree.
import { readFileSync } from 'node:fs';

const desktop = JSON.parse(readFileSync('desktop/package.json', 'utf8')).version;
const ui = JSON.parse(readFileSync('ui/package.json', 'utf8')).version;
const engine = /<Version>([^<]+)<\/Version>/.exec(readFileSync('engine/Directory.Build.props', 'utf8'))?.[1];

const all = { 'desktop/package.json': desktop, 'ui/package.json': ui, 'engine/Directory.Build.props': engine };
if (new Set(Object.values(all)).size !== 1) {
  for (const [file, v] of Object.entries(all)) console.log(`::error file=${file}::version ${v}`);
  console.error('Versions disagree:', all);
  process.exit(1);
}
console.log(`version ${desktop}`);
