/**
 * 把逐尺寸渲染好的 PNG 打包成各平台需要的图标资源。
 * ICO 与 ICNS 都直接内嵌 PNG 字节流，不依赖任何第三方库，也不需要缩放位图。
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/code/learning-hub/design/app-icon';
const SRC = path.join(ROOT, 'build/sizes');
const OUT = path.join(ROOT, 'build');
const NAME = 'hertz-lyrics';

/* ---------- 读 PNG 头，确认尺寸与色彩类型 ---------- */
function pngInfo(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG: ' + file);
  return {
    w: b.readUInt32BE(16),
    h: b.readUInt32BE(20),
    depth: b[24],
    colorType: b[25],           // 6 = RGBA（带透明通道）
    bytes: b
  };
}

const cache = {};
function load(size) {
  if (!cache[size]) {
    const p = path.join(SRC, size + '.png');
    const info = pngInfo(p);
    if (info.w !== size || info.h !== size) throw new Error(`尺寸不符：期望 ${size}，实得 ${info.w}x${info.h}`);
    if (info.colorType !== 6) throw new Error(`缺少透明通道（colorType=${info.colorType}）：${p}`);
    cache[size] = info;
  }
  return cache[size];
}

/* ---------- 1 · macOS iconset ---------- */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_64x64.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];
const iconsetDir = path.join(OUT, NAME + '.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });
ICONSET.forEach(([name, size]) => fs.writeFileSync(path.join(iconsetDir, name), load(size).bytes));
console.log('iconset  ✓', ICONSET.length, '个文件');

/* ---------- 2 · ICNS（'icns' + 若干 type 条目，条目数据即 PNG） ---------- */
const ICNS_MAP = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['icp6', 64],
  ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]
];
const icnsEntries = ICNS_MAP.map(([type, size]) => {
  const data = load(size).bytes;
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const icnsBody = Buffer.concat(icnsEntries);
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii');
icnsHead.writeUInt32BE(icnsBody.length + 8, 4);
fs.writeFileSync(path.join(OUT, NAME + '.icns'), Buffer.concat([icnsHead, icnsBody]));
console.log('icns     ✓', ICNS_MAP.length, '档  →', NAME + '.icns');

/* ---------- 3 · ICO（ICONDIR + 目录项 + PNG 数据） ---------- */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoDir = Buffer.alloc(6);
icoDir.writeUInt16LE(0, 0);                  // reserved
icoDir.writeUInt16LE(1, 2);                  // type = icon
icoDir.writeUInt16LE(ICO_SIZES.length, 4);   // count

const icoEntries = [];
let offset = 6 + 16 * ICO_SIZES.length;
ICO_SIZES.forEach((s) => {
  const data = load(s).bytes;
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);         // width（256 记为 0）
  e.writeUInt8(s >= 256 ? 0 : s, 1);         // height
  e.writeUInt8(0, 2);                        // colorCount
  e.writeUInt8(0, 3);                        // reserved
  e.writeUInt16LE(1, 4);                     // planes
  e.writeUInt16LE(32, 6);                    // bitCount
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  icoEntries.push(e);
});
fs.writeFileSync(
  path.join(OUT, NAME + '.ico'),
  Buffer.concat([icoDir, ...icoEntries, ...ICO_SIZES.map((s) => load(s).bytes)])
);
console.log('ico      ✓', ICO_SIZES.join(' / '), '→', NAME + '.ico');

/* ---------- 4 · 通用 PNG（文档 / 网页 / 商店） ---------- */
const pngDir = path.join(OUT, 'png');
fs.mkdirSync(pngDir, { recursive: true });
[16, 32, 64, 128, 256, 512, 1024].forEach((s) => {
  fs.writeFileSync(path.join(pngDir, `${NAME}-${s}.png`), load(s).bytes);
});
console.log('png      ✓ 7 档');

/* ---------- 5 · 带上定稿 SVG，保证源文件随包走 ---------- */
const svgOut = path.join(OUT, 'svg');
fs.mkdirSync(svgOut, { recursive: true });
['hertz-lyrics-glass.svg', 'hertz-lyrics-small.svg'].forEach((f) => {
  fs.copyFileSync(path.join(ROOT, 'svg', f), path.join(svgOut, f));
});
console.log('svg      ✓ 定稿已随包');
