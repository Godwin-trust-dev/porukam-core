"""Пайплайн приёма JPEG (ГВ.3, docs/tasks/global-wave.md): EXIF-очистка по
ADR-045 (доказательные фото несут геометки — адрес объекта; публикация/
долгосрочное хранение без очистки слило бы его) + добыча миниатюры-заглушки
из уже встроенного камерой EXIF-превью.

Чистый Python, БЕЗ внешних зависимостей (Pillow и т.п.): сеть для установки
пакетов недоступна в части окружений деплоя этого коммита, а разбор JPEG-
сегментов/TIFF-IFD не требует декодирования пикселей — только байтовый
парсинг маркеров (структура JPEG/Exif/TIFF — открытые спецификации,
ITU-T T.81 / CIPA DC-008). Решение сознательно устойчиво к сети как таковой
(детерминированный пайплайн доказательств не должен зависеть от pip-индекса
в проде) — не временный воркэраунд.

Стратегия очистки — «вырезать целиком», не редактировать точечно: ЛЮБОЙ
сегмент APP1 (Exif ИЛИ XMP — оба используют один маркер 0xFFE1), APP13
(Photoshop IRB/IPTC — тоже может нести геометки) и COM (произвольный
комментарий) удаляются из потока целиком. Остаётся только то, что нужно
декодеру для показа изображения (JFIF/APP0, DQT/DHT/SOF/SOS/данные
сканирования) — GPS/Make/Model/произвольные теги физически не могут
"просочиться" точечным пропуском поля, раз всего сегмента больше нет.

Миниатюра — не сгенерированная (для этого нужен декодер пикселей), а
ВСТРОЕННАЯ камерой в EXIF (IFD1 `JPEGInterchangeFormat`/`...Length`,
CIPA DC-008 §4.6.4) — извлекается ДО удаления сегмента, что даёт настоящий
уменьшенный JPEG без стороннего декодера. Если встроенной миниатюры нет
(редактор её не проставил) — `thumbnail=None`, честно, без подделки."""

from __future__ import annotations

import struct
from collections.abc import Iterator
from dataclasses import dataclass

_SOI = b"\xff\xd8"
_EOI = 0xFFD9
_SOS = 0xFFDA
_APP1 = 0xFFE1
_APP13 = 0xFFED
_COM = 0xFFFE
_STRIPPED_MARKERS = frozenset({_APP1, _APP13, _COM})
_SOF_MARKERS = frozenset({0xFFC0, 0xFFC1, 0xFFC2, 0xFFC3, 0xFFC5, 0xFFC6, 0xFFC7})
# Маркеры без поля длины (не встречаются между SOI и SOS у нормальных
# файлов, но на всякий случай не читаем за пределы потока).
_NO_LENGTH_MARKERS = frozenset({0xFF01, *range(0xFFD0, 0xFFD8)})

_EXIF_HEADER = b"Exif\x00\x00"
_TAG_MAKE = 0x010F
_TAG_MODEL = 0x0110
_TAG_GPS_IFD_POINTER = 0x8825
_TAG_THUMB_OFFSET = 0x0201
_TAG_THUMB_LENGTH = 0x0202
_TIFF_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


class NotAJpegError(ValueError):
    """Файл не начинается с SOI (0xFFD8) — не JPEG."""


@dataclass(frozen=True, slots=True)
class JpegDimensions:
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class ExifSummary:
    gps_present_in_original: bool
    make: str | None
    model: str | None
    thumbnail: bytes | None


@dataclass(frozen=True, slots=True)
class JpegIngestResult:
    clean_bytes: bytes
    dimensions: JpegDimensions | None
    exif: ExifSummary


def _segments(data: bytes) -> Iterator[tuple[int, int, int, bool]]:
    """(marker, payload_start, payload_end, is_sos) по сегментам после SOI —
    payload НЕ включает 2 байта длины (кроме `is_sos=True`: там
    `payload_start` — начало САМОГО маркера SOS, до конца файла копируется
    целиком, включая заголовок сканирования и энтропийные данные — искать
    дальнейшие маркеры внутри них не нужно для наших целей, вырезаем
    только метаданные ДО начала сканирования)."""
    pos = 2
    n = len(data)
    while pos + 1 < n:
        if data[pos] != 0xFF:
            # Байт-заполнитель (0xFF00 padding и т.п.) — просто продвигаемся.
            pos += 1
            continue
        marker = struct.unpack_from(">H", data, pos)[0]
        if marker in _NO_LENGTH_MARKERS:
            pos += 2
            continue
        if marker == _SOS:
            yield marker, pos, n, True
            return
        if marker == _EOI or pos + 4 > n:
            return
        (length,) = struct.unpack_from(">H", data, pos + 2)
        payload_start = pos + 4
        payload_end = pos + 2 + length
        if payload_end > n:
            return
        yield marker, payload_start, payload_end, False
        pos = payload_end


def _read_ascii(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("ascii", errors="replace")


def _parse_ifd(
    tiff: bytes, offset: int, endian: str
) -> tuple[dict[int, tuple[int, int, bytes]], int]:
    """Один IFD: {tag: (type, count, value_bytes_4)} + offset следующего IFD
    (0 — нет). `value_bytes_4` — те самые 4 "value/offset"-байта записи;
    интерпретация (инлайн-значение или офсет на данные) — на вызывающей
    стороне, где известен размер типа."""
    (count,) = struct.unpack_from(f"{endian}H", tiff, offset)
    entries: dict[int, tuple[int, int, bytes]] = {}
    entry_pos = offset + 2
    for _ in range(count):
        tag, type_, cnt = struct.unpack_from(f"{endian}HHI", tiff, entry_pos)
        value_bytes = tiff[entry_pos + 8 : entry_pos + 12]
        entries[tag] = (type_, cnt, value_bytes)
        entry_pos += 12
    (next_ifd,) = struct.unpack_from(f"{endian}I", tiff, entry_pos)
    return entries, next_ifd


def _entry_uint(tiff: bytes, endian: str, type_: int, cnt: int, value_bytes: bytes) -> int:
    size = _TIFF_TYPE_SIZES.get(type_, 4) * cnt
    fmt = {1: "B", 3: "H", 4: "I"}.get(type_)
    if fmt is None or size > 4:
        (offset,) = struct.unpack_from(f"{endian}I", value_bytes)
        return int(offset)
    return int(struct.unpack_from(f"{endian}{fmt}", value_bytes)[0])


def _entry_ascii(tiff: bytes, endian: str, type_: int, cnt: int, value_bytes: bytes) -> str:
    if cnt <= 4:
        return _read_ascii(value_bytes[:cnt])
    (offset,) = struct.unpack_from(f"{endian}I", value_bytes)
    return _read_ascii(tiff[offset : offset + cnt])


def _parse_exif_block(payload: bytes) -> ExifSummary:
    """`payload` — содержимое APP1 БЕЗ маркера/длины, начинается с
    `Exif\\x00\\x00`. Любая ошибка разбора -> максимально пустая честная
    сводка (сегмент всё равно будет вырезан вызывающей стороной — сбой
    парсинга миниатюры/тегов не блокирует саму очистку)."""
    empty = ExifSummary(gps_present_in_original=False, make=None, model=None, thumbnail=None)
    if not payload.startswith(_EXIF_HEADER):
        return empty
    tiff = payload[len(_EXIF_HEADER) :]
    if len(tiff) < 8:
        return empty
    try:
        byte_order = tiff[:2]
        endian = "<" if byte_order == b"II" else ">" if byte_order == b"MM" else None
        if endian is None:
            return empty
        (ifd0_offset,) = struct.unpack_from(f"{endian}I", tiff, 4)
        ifd0, ifd1_offset = _parse_ifd(tiff, ifd0_offset, endian)

        gps_present = _TAG_GPS_IFD_POINTER in ifd0
        make = model = None
        if _TAG_MAKE in ifd0:
            type_, cnt, value_bytes = ifd0[_TAG_MAKE]
            make = _entry_ascii(tiff, endian, type_, cnt, value_bytes) or None
        if _TAG_MODEL in ifd0:
            type_, cnt, value_bytes = ifd0[_TAG_MODEL]
            model = _entry_ascii(tiff, endian, type_, cnt, value_bytes) or None

        thumbnail: bytes | None = None
        if ifd1_offset:
            ifd1, _next = _parse_ifd(tiff, ifd1_offset, endian)
            if _TAG_THUMB_OFFSET in ifd1 and _TAG_THUMB_LENGTH in ifd1:
                t_type, t_cnt, t_value = ifd1[_TAG_THUMB_OFFSET]
                l_type, l_cnt, l_value = ifd1[_TAG_THUMB_LENGTH]
                thumb_offset = _entry_uint(tiff, endian, t_type, t_cnt, t_value)
                thumb_length = _entry_uint(tiff, endian, l_type, l_cnt, l_value)
                candidate = tiff[thumb_offset : thumb_offset + thumb_length]
                if candidate[:2] == _SOI:
                    thumbnail = candidate
        return ExifSummary(
            gps_present_in_original=gps_present, make=make, model=model, thumbnail=thumbnail
        )
    except (struct.error, IndexError):
        return empty


def _dimensions_from_sof(payload: bytes) -> JpegDimensions | None:
    # payload: precision(1) + height(2 BE) + width(2 BE) + ...
    if len(payload) < 5:
        return None
    _precision, height, width = struct.unpack_from(">BHH", payload, 0)
    return JpegDimensions(width=width, height=height)


def ingest_jpeg(data: bytes) -> JpegIngestResult:
    """Точка входа пайплайна (ГВ.3 п.1): один проход по сегментам — собирает
    `clean_bytes` (без APP1/APP13/COM), сводку EXIF (GPS-присутствие в
    ОРИГИНАЛЕ — не в результате, туда GPS не попадает никогда, ни в каком
    виде — и добытую миниатюру) и размеры кадра."""
    if data[:2] != _SOI:
        raise NotAJpegError("файл не начинается с JPEG SOI (0xFFD8)")

    kept = bytearray(_SOI)
    exif_summary = ExifSummary(gps_present_in_original=False, make=None, model=None, thumbnail=None)
    dimensions: JpegDimensions | None = None

    for marker, payload_start, payload_end, is_sos in _segments(data):
        if is_sos:
            kept += data[payload_start:]
            break
        if marker in _SOF_MARKERS and dimensions is None:
            dimensions = _dimensions_from_sof(data[payload_start:payload_end])
        if marker == _APP1 and data[payload_start:payload_end].startswith(_EXIF_HEADER):
            exif_summary = _parse_exif_block(data[payload_start:payload_end])
        if marker in _STRIPPED_MARKERS:
            continue
        kept += data[payload_start - 4 : payload_end]

    return JpegIngestResult(clean_bytes=bytes(kept), dimensions=dimensions, exif=exif_summary)
