/**
 * PNG-хелперы витринных кадров (`store-screenshots.spec.ts`).
 *
 * Зачем свой кодек: Google Play принимает «24-битный PNG без альфы», а
 * Playwright всегда пишет RGBA (color type 6). Библиотеки картинок в проекте
 * нет (ни sharp, ни pngjs) и тянуть её ради восьми кадров незачем — разбор и
 * сборка PNG с фильтрами укладываются в сотню строк на встроенном `zlib`.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  /** 2 — truecolour (RGB, без альфы), 6 — RGBA. */
  colorType: number;
}

/** Заголовок PNG (IHDR) без разбора пикселей — для проверок в тестах. */
export function readPngInfo(png: Buffer): PngInfo {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  };
}

/** Снимает фильтры строк (спецификация PNG §9.2), возвращает сырые пиксели. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]!;
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      const v = line[x]!;
      let value: number;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }
  return out;
}

/**
 * RGBA-PNG → 24-битный RGB-PNG без альфа-канала (требование Google Play).
 * Альфа у скриншотов всегда 255, поэтому канал просто отбрасывается —
 * смешивать с фоном не нужно.
 */
export function toRgbPng(png: Buffer): Buffer {
  const info = readPngInfo(png);
  if (info.bitDepth !== 8) throw new Error(`unsupported bit depth ${info.bitDepth}`);
  if (info.colorType === 2) return png;
  if (info.colorType !== 6) throw new Error(`unsupported colour type ${info.colorType}`);

  const idat: Buffer[] = [];
  let pos = 8;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + length));
    pos += 12 + length;
  }
  const rgba = unfilter(inflateSync(Buffer.concat(idat)), info.width, info.height, 4);

  const rgbStride = info.width * 3;
  const filtered = Buffer.alloc((rgbStride + 1) * info.height);
  for (let y = 0; y < info.height; y += 1) {
    filtered[y * (rgbStride + 1)] = 0; // фильтр None: кадры и так хорошо жмутся
    for (let x = 0; x < info.width; x += 1) {
      const src = (y * info.width + x) * 4;
      const dst = y * (rgbStride + 1) + 1 + x * 3;
      filtered[dst] = rgba[src]!;
      filtered[dst + 1] = rgba[src + 1]!;
      filtered[dst + 2] = rgba[src + 2]!;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(info.width, 0);
  ihdr.writeUInt32BE(info.height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
