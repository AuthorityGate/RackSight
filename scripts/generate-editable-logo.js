'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'public', 'racksight-icon-chocolate.png');
const ORIGINAL = path.join(ROOT, 'Logo', 'racksight-icon.png');
const FLAT_PNG = path.join(ROOT, 'Logo', 'racksight-logo-flat.png');
const EDITABLE_SVG = path.join(ROOT, 'Logo', 'racksight-logo-editable.svg');

// These are the only two exported logo colors.
const SERVER_COLOR = [0x9B, 0x23, 0x35];
const ARCH_COLOR = [0x2C, 0x2C, 0x2C];

// The Chocolate asset is the exact original silhouette reduced to two flat
// source colors. Its alpha channel is byte-for-byte identical to the original.
const SERVER_MASK_COLOR = [0, 0, 0];
const ARCH_MASK_COLOR = [0xE8, 0xDC, 0xC8];

function sameRgb(data, offset, color) {
  return data[offset] === color[0] && data[offset + 1] === color[1] && data[offset + 2] === color[2];
}

function maskPng(width, height) {
  return new PNG({ width, height, colorType: 6 });
}

const source = PNG.sync.read(fs.readFileSync(SOURCE));
const original = PNG.sync.read(fs.readFileSync(ORIGINAL));
if (source.width !== original.width || source.height !== original.height) throw new Error('Logo dimensions do not match.');

const serversMask = maskPng(source.width, source.height);
const archMask = maskPng(source.width, source.height);
const flat = maskPng(source.width, source.height);
let serverPixels = 0;
let archPixels = 0;

for (let offset = 0; offset < source.data.length; offset += 4) {
  const alpha = source.data[offset + 3];
  if (alpha !== original.data[offset + 3]) throw new Error(`Source silhouette differs from the original at pixel ${offset / 4}.`);

  const isServer = sameRgb(source.data, offset, SERVER_MASK_COLOR);
  const isArch = sameRgb(source.data, offset, ARCH_MASK_COLOR);
  if (alpha && isServer === isArch) throw new Error(`Pixel ${offset / 4} is not assigned to exactly one logo layer.`);

  for (const mask of [serversMask, archMask]) {
    mask.data[offset] = 255;
    mask.data[offset + 1] = 255;
    mask.data[offset + 2] = 255;
  }
  serversMask.data[offset + 3] = isServer ? alpha : 0;
  archMask.data[offset + 3] = isArch ? alpha : 0;

  const color = isArch ? ARCH_COLOR : SERVER_COLOR;
  flat.data[offset] = color[0];
  flat.data[offset + 1] = color[1];
  flat.data[offset + 2] = color[2];
  flat.data[offset + 3] = alpha;
  if (alpha && isServer) serverPixels += 1;
  if (alpha && isArch) archPixels += 1;
}

const serversMaskData = PNG.sync.write(serversMask).toString('base64');
const archMaskData = PNG.sync.write(archMask).toString('base64');
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${source.width}" height="${source.height}" viewBox="0 0 ${source.width} ${source.height}" role="img" aria-labelledby="title description">
  <title id="title">RackSight editable logo</title>
  <desc id="description">The exact RackSight logo silhouette with independently editable flat server and arch colors.</desc>

  <!-- QUICK COLOR EDITS: change only these two hex values. -->
  <style>
    .server-color { fill: #9B2335; }
    .arch-color { fill: #2C2C2C; }
  </style>

  <defs>
    <!-- Embedded alpha masks preserve the supplied logo geometry exactly. -->
    <mask id="servers-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${source.width}" height="${source.height}" style="mask-type:alpha">
      <image width="${source.width}" height="${source.height}" href="data:image/png;base64,${serversMaskData}" xlink:href="data:image/png;base64,${serversMaskData}"/>
    </mask>
    <mask id="arch-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${source.width}" height="${source.height}" style="mask-type:alpha">
      <image width="${source.width}" height="${source.height}" href="data:image/png;base64,${archMaskData}" xlink:href="data:image/png;base64,${archMaskData}"/>
    </mask>
  </defs>

  <rect id="servers" class="server-color" width="${source.width}" height="${source.height}" mask="url(#servers-mask)"/>
  <rect id="arch" class="arch-color" width="${source.width}" height="${source.height}" mask="url(#arch-mask)"/>
</svg>
`;

fs.writeFileSync(FLAT_PNG, PNG.sync.write(flat));
fs.writeFileSync(EDITABLE_SVG, svg);
console.log(`Generated exact ${source.width}x${source.height} logo: ${serverPixels} server pixels, ${archPixels} arch pixels.`);
