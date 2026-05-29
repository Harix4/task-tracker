#!/usr/bin/env node
// Generates icon-192.png and icon-512.png using pure Node.js (no canvas dep)
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const c = u32(crc32(Buffer.concat([t, data])));
  return Buffer.concat([u32(data.length), t, data, c]);
}

function makePng(size) {
  const BG = [0x00, 0x71, 0xe3]; // #0071e3 blue
  const FG = [0xff, 0xff, 0xff]; // white

  // T shape proportions
  const pad   = Math.round(size * 0.16);
  const barH  = Math.round(size * 0.20);
  const stemW = Math.round(size * 0.20);
  const stemX = Math.round((size - stemW) / 2);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // PNG filter byte: None
    for (let x = 0; x < size; x++) {
      const inBar  = y >= pad && y < pad + barH && x >= pad && x < size - pad;
      const inStem = y >= pad && y < size - pad  && x >= stemX && x < stemX + stemW;
      row.push(...((inBar || inStem) ? FG : BG));
    }
    rows.push(Buffer.from(row));
  }

  const compressed = zlib.deflateSync(Buffer.concat(rows));

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', Buffer.concat([u32(size), u32(size), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'src', 'public');
fs.mkdirSync(outDir, { recursive: true });

[192, 512].forEach(size => {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, makePng(size));
  console.log(`✓ ${file} (${size}×${size})`);
});
