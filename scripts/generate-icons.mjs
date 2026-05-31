// Generates the PWA icons from the IRONLOG "▚" brand mark — no dependencies,
// just Node's built-in zlib to encode PNGs. Run: node scripts/generate-icons.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public");
fs.mkdirSync(outDir, { recursive: true });

const BG = [10, 11, 13];       // --bg  #0a0b0d
const ACCENT = [216, 255, 54]; // --accent #d8ff36

// CRC32 + PNG chunk helpers
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Draw one icon and return a PNG buffer.
function makePng(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  // background
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  // the "▚" mark: a centered square split into 4 quadrants, fill upper-left
  // + lower-right. Smaller safe zone when maskable (platform crops edges).
  const markFrac = maskable ? 0.46 : 0.56;
  const m = Math.round(size * markFrac);
  const ox = Math.round((size - m) / 2);
  const oy = Math.round((size - m) / 2);
  const half = Math.round(m / 2);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const ul = x < half && y < half;
      const lr = x >= half && y >= half;
      if (ul || lr) set(ox + x, oy + y, ACCENT);
    }
  }

  // PNG assembly: IHDR + IDAT (filter byte 0 per row) + IEND
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon.png", 180, {}],
  ["favicon-32.png", 32, {}],
];
for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(outDir, name), makePng(size, opts));
  console.log("wrote", name, `(${size}x${size})`);
}
