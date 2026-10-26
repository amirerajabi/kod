// Generates the Kod app icon without image libraries (the Rowlit approach): a navy rounded tile with a "K" in a
// pink-to-violet gradient and an amber dot, the same mark the UI draws (ui/src/components/common/icons.tsx KodMark).
//
//   build/icon.png   512x512 window / taskbar / Linux icon (also copied to resources/icon.png)
//   build/icon.ico   16, 24, 32, 48, 64, 128, 256 (BMP entries for small sizes, PNG for 256)
//   build/icon.icns  16..1024 PNG entries on Apple's 824/1024 grid
//   ../ui/public/favicon.svg
//
// Rasters evaluate signed distance functions of the same shapes with supersampling. Run: npm run icon (in desktop/).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const buildDir = dirname(fileURLToPath(import.meta.url));
const uiPublic = join(buildDir, '..', '..', 'ui', 'public');

// kept in step with the --brand-* tokens in ui/src/theme/tokens.css
const PALETTE = { tileTop: '#2a2f5e', tileBottom: '#0d1030', kStart: '#ff5fa2', kEnd: '#7c5cff', dot: '#ffc54d' };

// The mark on a 64-unit grid (the SVG artwork): tile 2..62 r14, K strokes width 7, dot at (46,46) r4.
const STROKES = [
  [20, 16, 20, 48],
  [20, 32, 36, 16],
  [26, 27, 38, 48],
];
const STROKE_W = 7;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const C = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hex(v)]));

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function over(dst, rgb, a) {
  for (let i = 0; i < 3; i++) dst[i] = rgb[i] * a + dst[i] * (1 - a);
  dst[3] = a + dst[3] * (1 - a);
}

/** Premultiplied RGBA at (x, y) in 64-unit space; `mac` shrinks the tile onto the 824/1024 grid with a shadow. */
function sample(x, y, mac) {
  const out = [0, 0, 0, 0];
  let u = x, v = y;
  if (mac) {
    const k = 64 / (64 * 824 / 1024);
    const off = (64 - 64 * 824 / 1024) / 2;
    u = (x - off) * k;
    v = (y - off) * k;
    const sd = sdRoundRect(u, v - 1.2, 2, 2, 62, 62, 14);
    if (sd > 0) {
      const a = 0.24 * Math.exp(-((sd / 1.6) ** 2));
      if (a > 0.001) over(out, [0, 0, 0], a);
    }
  }
  if (sdRoundRect(u, v, 2, 2, 62, 62, 14) > 0) return out;
  over(out, mix(C.tileTop, C.tileBottom, (v - 2) / 60), 1);
  let d = Infinity;
  for (const [ax, ay, bx, by] of STROKES) d = Math.min(d, sdSegment(u, v, ax, ay, bx, by));
  if (d <= STROKE_W / 2) over(out, mix(C.kStart, C.kEnd, Math.min(1, Math.max(0, ((u - 16) + (v - 16)) / 48))), 1);
  if (Math.hypot(u - 46, v - 46) <= 4) over(out, C.dot, 1);
  return out;
}

function render(size, mac = false) {
  const ss = size <= 64 ? 8 : size <= 256 ? 4 : 3;
  const px = Buffer.alloc(size * size * 4);
  const scale = 64 / size;
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((pxx + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale, mac);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      const n = ss * ss, o = (py * size + pxx) * 4, alpha = a / n;
      if (alpha > 0) {
        px[o] = Math.round(Math.min(1, r / n / alpha) * 255);
        px[o + 1] = Math.round(Math.min(1, g / n / alpha) * 255);
        px[o + 2] = Math.round(Math.min(1, b / n / alpha) * 255);
      }
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

// ---- PNG / ICO / ICNS writers -------------------------------------------------------------------------------------
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * w);
  for (let y = 0; y < w; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  const stride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (rgba[((size - 1 - y) * size + x) * 4 + 3] === 0) and[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  return Buffer.concat([header, xor, and]);
}
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...images.map((i) => i.data)]);
}
function icns(items) {
  const chunks = items.map(({ type, data }) => {
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([h, ...chunks]);
}

// ---- outputs --------------------------------------------------------------------------------------------------------
writeFileSync(join(buildDir, 'icon.png'), png(512, render(512)));
writeFileSync(join(buildDir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: size === 256 ? png(size, render(size)) : dib(size, render(size)) }))));
const ICNS = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512], ['ic10', 1024]];
const mac = new Map();
writeFileSync(join(buildDir, 'icon.icns'), icns(ICNS.map(([type, size]) => {
  if (!mac.has(size)) mac.set(size, png(size, render(size, true)));
  return { type, data: mac.get(size) };
})));
writeFileSync(join(uiPublic, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PALETTE.tileTop}"/><stop offset="1" stop-color="${PALETTE.tileBottom}"/></linearGradient><linearGradient id="k" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PALETTE.kStart}"/><stop offset="1" stop-color="${PALETTE.kEnd}"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#t)"/><path d="${STROKES.map(([a, b, c, d]) => `M${a} ${b}L${c} ${d}`).join('')}" stroke="url(#k)" stroke-width="${STROKE_W}" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="46" cy="46" r="4" fill="${PALETTE.dot}"/></svg>\n`);
console.log('icon: wrote build/icon.png (512), build/icon.ico (16-256), build/icon.icns (16-1024), ui/public/favicon.svg');
