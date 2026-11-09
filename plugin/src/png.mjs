import { deflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type), body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

/** Native RGBA PNG. No antialiasing, resampling, palette changes or background. */
export function encodePNG(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 4096 || height > 4096 || rgba.length !== width * height * 4) {
    throw new Error('Invalid PNG dimensions or RGBA length.');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const glyphs = {
  '1': ['010','110','010','010','111'], '2': ['110','001','010','100','111'],
  '3': ['110','001','010','001','110'], '4': ['101','101','111','001','001'],
  '5': ['111','100','110','001','110'], '6': ['011','100','110','101','010'],
  '7': ['111','001','010','010','010'], '8': ['010','101','010','101','010'],
  X: ['101','101','010','101','101'],
};
/** One attachment contains 1x and integer nearest-neighbor detail on a checkerboard. */
export function previewBoard(image, scale = 6) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 8) throw new Error('Preview scale must be an integer from 1 to 8.');
  const padding = 12, top = 24, leftWidth = Math.max(image.width, 48);
  const width = leftWidth + image.width * scale + padding * 3;
  const height = Math.max(image.height * scale, image.height) + top + padding;
  const rgba = new Uint8Array(width * height * 4);
  const put = (x, y, c) => rgba.set(c, (y * width + x) * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, [24, 27, 38, 255]);
  const label = (text, x) => {
    for (const char of text) {
      glyphs[char]?.forEach((row, y) => [...row].forEach((v, dx) => {
        if (v === '1') put(x + dx, 9 + y, [211, 220, 235, 255]);
      }));
      x += 5;
    }
  };
  const paste = (ox, zoom) => {
    for (let y = 0; y < image.height * zoom; y++) for (let x = 0; x < image.width * zoom; x++) {
      const i = (Math.floor(y / zoom) * image.width + Math.floor(x / zoom)) * 4;
      const alpha = image.rgba[i + 3] / 255;
      const bg = ((Math.floor(x / (4 * zoom)) + Math.floor(y / (4 * zoom))) & 1) ? [43, 48, 63] : [36, 40, 54];
      put(ox + x, top + y, [0, 1, 2].map(k => Math.round(image.rgba[i + k] * alpha + bg[k] * (1 - alpha))).concat(255));
    }
  };
  label('1X', padding); label(`${scale}X`, leftWidth + padding * 2);
  paste(padding, 1); paste(leftWidth + padding * 2, scale);
  return { width, height, rgba, panels: { native: { x: padding, y: top, width: image.width, height: image.height }, detail: { x: leftWidth + padding * 2, y: top, scale } } };
}
