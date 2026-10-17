import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['src/background.js', 'src/review.js'], outdir: 'dist', bundle: true,
  format: 'esm', target: 'chrome120', sourcemap: true, legalComments: 'eof' });
await cp('vendor/google-photos-toolkit/LICENSE', 'dist/GOOGLE-PHOTOS-TOOLKIT-LICENSE.txt');
await cp('vendor/README.md', 'dist/THIRD-PARTY-NOTICES.md');

// Small code-drawn icon: a cream photo frame on a green rounded square.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
for (const size of [16, 32, 128]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / size, ny = y / size, edge = Math.min(nx, ny, 1 - nx, 1 - ny);
    let color = [48, 93, 66, 255];
    if (edge < .04 && (nx < .12 || nx > .88) && (ny < .12 || ny > .88)) color = [0, 0, 0, 0];
    if (nx > .22 && nx < .78 && ny > .22 && ny < .78) color = [238, 243, 224, 255];
    if (nx > .28 && nx < .72 && ny > .28 && ny < .70) color = [109, 145, 92, 255];
    if ((nx - .59) ** 2 + (ny - .39) ** 2 < .004) color = [238, 243, 224, 255];
    if (nx > .28 && nx < .72 && ny < .70 && ny > .57 - .20 * Math.sin((nx - .28) * 10)) color = [57, 101, 63, 255];
    const index = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set(color, index);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(`dist/icon${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
console.log(`Built ${manifest.name} ${manifest.version} → ${process.cwd()}/dist`);
