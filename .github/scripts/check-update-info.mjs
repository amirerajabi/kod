// Checks electron-builder's update metadata (latest.yml, latest-mac.yml, latest-linux.yml) in a folder: each required
// file exists, names the tag's version, and every file it lists (url / path) is in the folder under that exact name,
// with the size it records. Installed copies only update when this holds.
//   node check-update-info.mjs <dir> --tag v0.3.0 --require latest.yml,latest-mac.yml
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const tag = arg('--tag');
const required = (arg('--require') ?? 'latest.yml').split(',').filter(Boolean);
const version = tag?.replace(/^v/, '');
let failed = false;
const fail = (msg) => {
  console.log(`::error::${msg}`);
  failed = true;
};

for (const name of required) {
  const file = join(dir, name);
  if (!existsSync(file)) {
    fail(`${name} is missing from ${dir}`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const v = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (version && v !== version) fail(`${name} is version ${v}, the tag is ${tag}`);
  // "- url: X" + the "size: N" that follows it in the same entry
  const entries = [...text.matchAll(/-\s+url:\s*(\S+)\s*\n(?:\s+\w+:.*\n)*?\s+size:\s*(\d+)/g)].map((m) => ({ url: m[1], size: Number(m[2]) }));
  const path = /^path:\s*(\S+)/m.exec(text)?.[1];
  if (entries.length === 0 && !path) fail(`${name} lists no files`);
  for (const { url, size } of entries) {
    const asset = join(dir, decodeURIComponent(url));
    if (!existsSync(asset)) fail(`${name} names ${url}, which is not in ${dir}`);
    else if (statSync(asset).size !== size) fail(`${name} records ${size} bytes for ${url}, the file has ${statSync(asset).size}`);
    else if (!existsSync(`${asset}.blockmap`)) console.log(`::warning::${url} has no .blockmap (full downloads only)`);
  }
  if (path && !existsSync(join(dir, path))) fail(`${name} path ${path} is not in ${dir}`);
  if (!failed) console.log(`${name}: version ${v}, ${entries.length} file(s) OK`);
}
process.exit(failed ? 1 : 0);
