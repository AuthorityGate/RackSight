'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'Logo', 'racksight-logo-flat.png');
const CLEAN_OUTPUT = path.join(ROOT, 'Logo', 'racksight-logo-black-gold-clean.png');
const THEME_OUTPUT = path.join(ROOT, 'public', 'racksight-icon-chocolate.png');

const SERVER_MASK_COLOR = [0x9B, 0x23, 0x35];
const ARCH_MASK_COLOR = [0x2C, 0x2C, 0x2C];
const GOLD = [0xC9, 0xA2, 0x27];
const BLACK = [0, 0, 0];

function sameRgb(data, offset, color) {
  return data[offset] === color[0] && data[offset + 1] === color[1] && data[offset + 2] === color[2];
}

const source = PNG.sync.read(fs.readFileSync(SOURCE));
const output = new PNG({ width: source.width, height: source.height, colorType: 6 });
let serverPixels = 0;
let archPixels = 0;

for (let offset = 0; offset < source.data.length; offset += 4) {
  const alpha = source.data[offset + 3];
  const isServer = sameRgb(source.data, offset, SERVER_MASK_COLOR);
  const isArch = sameRgb(source.data, offset, ARCH_MASK_COLOR);
  if (isServer === isArch) throw new Error(`Pixel ${offset / 4} is not assigned to exactly one logo layer.`);
  const color = isServer ? GOLD : BLACK;
  output.data[offset] = color[0];
  output.data[offset + 1] = color[1];
  output.data[offset + 2] = color[2];
  output.data[offset + 3] = alpha;
  if (alpha && isServer) serverPixels += 1;
  if (alpha && isArch) archPixels += 1;
}

const encoded = PNG.sync.write(output);
fs.writeFileSync(CLEAN_OUTPUT, encoded);
fs.writeFileSync(THEME_OUTPUT, encoded);
console.log(`Generated clean Black/Gold logo: ${serverPixels} gold server pixels, ${archPixels} black arch pixels.`);
