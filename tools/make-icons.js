#!/usr/bin/env node
/* Renders the Hexsphere app icons.
 *
 * The globe in the icon is the real board geometry — every pixel is assigned
 * to the nearest cell centre of an actual Goldberg sphere — so the icon can
 * never drift out of sync with the game. PNGs are encoded by hand with zlib,
 * which keeps the toolchain to plain Node.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

global.window = global;
require('../js/util.js');
require('../js/geometry.js');

const { V } = global.GS.util;
const sphere = global.GS.geometry.buildSphere(3);

const LIGHT = V.normalize([-0.4, 0.62, 0.68]);
const BG_TOP = [10, 16, 38];
const BG_BOTTOM = [5, 8, 22];
const CELL = [70, 132, 208];
const CELL_PENT = [92, 160, 232];
const LINE = [8, 13, 28];
const FLAG = [255, 84, 112];
const POLE = [238, 244, 255];

function encodePng(width, height, rgba) {
  const stride = width * 4;
  /* "Up" filtering: each row is stored as its difference from the row above,
   * which compresses these smooth gradients several times better. */
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    raw[base] = 2;
    for (let x = 0; x < stride; x++) {
      const here = rgba[y * stride + x];
      const above = y === 0 ? 0 : rgba[(y - 1) * stride + x];
      raw[base + 1 + x] = (here - above) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeInt32BE(crc32(out.slice(4, 8 + body.length)) | 0, 8 + body.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   /* bit depth */
  ihdr[9] = 6;   /* RGBA */
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* Which cell does this direction fall in, and how close is the boundary? */
function sampleGlobe(x, y, z) {
  let best = -1, bestDot = -2, secondDot = -2;
  const c = sphere.centers;
  for (let i = 0; i < sphere.count; i++) {
    const d = x * c[i * 3] + y * c[i * 3 + 1] + z * c[i * 3 + 2];
    if (d > bestDot) { secondDot = bestDot; bestDot = d; best = i; }
    else if (d > secondDot) { secondDot = d; }
  }
  return { cell: best, edge: bestDot - secondDot };
}

/* The cell that carries the little flag, chosen near the upper right. */
const FLAG_CELL = (() => {
  const want = V.normalize([0.42, 0.34, 0.84]);
  let best = 0, bestDot = -2;
  for (let i = 0; i < sphere.count; i++) {
    const d = want[0] * sphere.centers[i * 3] + want[1] * sphere.centers[i * 3 + 1] +
      want[2] * sphere.centers[i * 3 + 2];
    if (d > bestDot) { bestDot = d; best = i; }
  }
  return best;
})();

function renderIcon(size, opts) {
  const ss = 2;                        /* supersampling factor */
  const w = size * ss;
  const globeR = w * (opts.maskable ? 0.34 : 0.44);
  const cx = w / 2, cy = w / 2;
  const out = Buffer.alloc(size * size * 4);

  const flagDir = [
    sphere.centers[FLAG_CELL * 3], sphere.centers[FLAG_CELL * 3 + 1], sphere.centers[FLAG_CELL * 3 + 2]
  ];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = px * ss + sx + 0.5;
          const fy = py * ss + sy + 0.5;
          const c = shadePixel(fx, fy);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);

  function shadePixel(fx, fy) {
    const dx = (fx - cx) / globeR;
    const dy = (fy - cy) / globeR;
    const r2 = dx * dx + dy * dy;

    /* Background: vertical gradient, with a soft halo behind the globe. */
    const t = fy / w;
    let bg = [
      BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t,
      BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t,
      BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
    ];
    if (r2 > 1 && r2 < 2.4) {
      const halo = Math.max(0, 1 - (Math.sqrt(r2) - 1) / 0.55) * 0.5;
      bg = [bg[0] + 60 * halo, bg[1] + 100 * halo, bg[2] + 160 * halo];
    }
    if (r2 > 1) {
      return opts.transparent ? [0, 0, 0, 0] : [bg[0], bg[1], bg[2], 255];
    }

    const z = Math.sqrt(1 - r2);
    const nx = dx, ny = -dy, nz = z;
    const { cell, edge } = sampleGlobe(nx, ny, nz);
    const ring = sphere.cellCorners[cell].length;

    let base = ring === 5 ? CELL_PENT : CELL;
    const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const lit = 0.34 + 0.78 * diffuse;
    let col = [base[0] * lit, base[1] * lit, base[2] * lit];

    /* Cell borders: the boundary is where two centres are equidistant. */
    const lineWidth = 0.016;
    if (edge < lineWidth) {
      const k = 1 - edge / lineWidth;
      col = [
        col[0] + (LINE[0] - col[0]) * k,
        col[1] + (LINE[1] - col[1]) * k,
        col[2] + (LINE[2] - col[2]) * k
      ];
    }

    /* Limb darkening keeps the sphere from looking like a flat disc. */
    const limb = Math.pow(z, 0.35);
    col = [col[0] * (0.55 + 0.45 * limb), col[1] * (0.55 + 0.45 * limb), col[2] * (0.55 + 0.45 * limb)];

    if (cell === FLAG_CELL && z > 0.25) {
      const local = flagLocal(nx, ny, nz, flagDir);
      const inPole = Math.abs(local.u + 0.16) < 0.055 && local.v > -0.34 && local.v < 0.4;
      const inFlag = local.v > 0.02 && local.v < 0.4 &&
        local.u > -0.16 && local.u < 0.16 + (0.4 - local.v) * 0.6;
      if (inPole) col = POLE.slice();
      else if (inFlag) col = FLAG.slice();
    }

    return [col[0], col[1], col[2], 255];
  }
}

/* Screen-space offset of a point from the flag cell's centre. */
function flagLocal(nx, ny, nz, dir) {
  const scale = 1 / (global.GS.geometry.cellCountFor(3) > 0 ? sphere.cellRadius : 1);
  return {
    u: (nx - dir[0]) * scale * 0.62,
    v: (ny - dir[1]) * scale * 0.62
  };
}

const webDir = path.join(__dirname, '..', 'icons');
const androidRes = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const jobs = [
  { file: path.join(webDir, 'icon-192.png'), size: 192 },
  { file: path.join(webDir, 'icon-512.png'), size: 512 },
  { file: path.join(webDir, 'icon-maskable-512.png'), size: 512, maskable: true },
  { file: path.join(webDir, 'apple-touch-icon.png'), size: 180 },
  /* Android launcher icons: legacy bitmaps per density, plus the foreground
   * layer of the adaptive icon (globe only, on transparency). */
  { file: path.join(androidRes, 'mipmap-mdpi', 'ic_launcher.png'), size: 48 },
  { file: path.join(androidRes, 'mipmap-hdpi', 'ic_launcher.png'), size: 72 },
  { file: path.join(androidRes, 'mipmap-xhdpi', 'ic_launcher.png'), size: 96 },
  { file: path.join(androidRes, 'mipmap-xxhdpi', 'ic_launcher.png'), size: 144 },
  { file: path.join(androidRes, 'mipmap-xxxhdpi', 'ic_launcher.png'), size: 192 },
  { file: path.join(androidRes, 'drawable', 'ic_launcher_foreground.png'), size: 432, maskable: true, transparent: true }
];

for (const job of jobs) {
  const png = renderIcon(job.size, job);
  fs.mkdirSync(path.dirname(job.file), { recursive: true });
  fs.writeFileSync(job.file, png);
  console.log('wrote', path.relative(path.join(__dirname, '..'), job.file),
    '(' + job.size + 'px, ' + (png.length / 1024).toFixed(1) + ' KB)');
}
