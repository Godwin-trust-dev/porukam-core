import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * Badge push-уведомления — мелкая иконка в статус-баре Android. Система берёт
 * из неё ТОЛЬКО альфа-канал: непрозрачная картинка рисуется сплошной заливкой,
 * то есть белым прямоугольником (жалоба владельца 10.09: «нет красивой иконки
 * сверху мелкой… просто белый квадратик»). Поэтому badge обязан быть отдельным
 * файлом с настоящей прозрачностью, а не цветной `icon-192.png`.
 *
 * Тест смотрит на два факта, которые ломаются молча: путь в `push-sw.js`
 * (SW не собирается сборщиком и в типах не участвует) и альфа самого PNG.
 */
// `import.meta.url` в jsdom-окружении не file-схема, поэтому идём от рабочей
// директории проекта vitest (`web/`), с запасом на запуск из корня монорепо.
const publicDir = [resolve(process.cwd(), 'public'), resolve(process.cwd(), 'web/public')].find((dir) =>
  existsSync(dir),
) as string;

const BADGE_PATH = '/icons/badge-96.png';

function readPngAlpha(file: string): { width: number; height: number; alpha: number[] } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let pos = 8;
  let idat = Buffer.alloc(0);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let depth = -1;
  let interlace = -1;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (tag === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body.readUInt8(8);
      colorType = body.readUInt8(9);
      interlace = body.readUInt8(12);
    } else if (tag === 'IDAT') {
      idat = Buffer.concat([idat, body]);
    }
    pos += 12 + len;
  }
  // 6 = truecolor + alpha. Без альфа-канала badge бессмыслен по построению.
  expect({ depth, colorType, interlace }).toEqual({ depth: 8, colorType: 6, interlace: 0 });
  const raw = inflateSync(idat);
  const stride = width * 4;
  const alpha: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    // Файл пишется без построчных фильтров — иначе строки пришлось бы разворачивать.
    expect(raw.readUInt8(rowStart)).toBe(0);
    for (let x = 0; x < width; x += 1) alpha.push(raw.readUInt8(rowStart + 1 + x * 4 + 3));
  }
  return { width, height, alpha };
}

describe('badge push-уведомления (10.09: белый квадрат в статус-баре)', () => {
  it('push-sw.js отдаёт монохромный badge, а цветную иконку оставляет в icon', () => {
    const sw = readFileSync(`${publicDir}/push-sw.js`, 'utf8');
    expect(sw).toContain(`badge: '${BADGE_PATH}'`);
    // ADR-180: в роли `icon` теперь фото контрагента, а цветной знак —
    // ФОЛБЭК, когда фото нет или его нельзя показывать. Проверяем именно
    // фолбэк-форму: голое `icon: '/icons/icon-192.png'` означало бы, что
    // фото контрагента снова потерялось.
    expect(sw).toContain("icon: data.icon || '/icons/icon-192.png'");
    // Ровно та ошибка, которую чиним: цветная 192 в роли badge.
    expect(sw).not.toContain("badge: '/icons/icon-192.png'");
  });

  it('badge-96.png — 96×96 с настоящей прозрачностью (не сплошная заливка)', () => {
    const { width, height, alpha } = readPngAlpha(`${publicDir}${BADGE_PATH}`);
    expect({ width, height }).toEqual({ width: 96, height: 96 });

    const visible = alpha.filter((a) => a > 0).length;
    const share = visible / alpha.length;
    // Силуэт занимает заметно меньше кадра; «почти всё непрозрачно» = тот самый квадрат.
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.5);
  });

  it('badge-96.png — безопасные поля по краям (силуэт не упирается в рамку)', () => {
    const { width, height, alpha } = readPngAlpha(`${publicDir}${BADGE_PATH}`);
    const at = (x: number, y: number): number => alpha[y * width + x] ?? 0;
    // Android подрезает и скругляет badge, поэтому у знака должны быть поля ~12%.
    const margin = Math.floor(width * 0.1);
    let inkInMargin = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const outside = x < margin || y < margin || x >= width - margin || y >= height - margin;
        if (outside && at(x, y) > 8) inkInMargin += 1;
      }
    }
    expect(inkInMargin).toBe(0);
  });
});
