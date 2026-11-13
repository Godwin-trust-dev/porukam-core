"""Байтовые фикстуры JPEG для тестов ГВ.3 (не test_*.py — pytest не
собирает как тесты, pyproject.toml `python_files`). Собраны вручную по той
же схеме, что парсит `services/evidence_ingest/jpeg.py` — оба конца
(конструктор здесь, разбор в проде) реализуют один открытый формат
(ITU-T T.81 / CIPA DC-008), так что фикстура — не подгонка под код, а
корректный (хоть и минимальный) JPEG с EXIF/GPS/встроенной миниатюрой."""

from __future__ import annotations

import struct


def _u16(v: int) -> bytes:
    return struct.pack(">H", v)


def _le16(v: int) -> bytes:
    return struct.pack("<H", v)


def _le32(v: int) -> bytes:
    return struct.pack("<I", v)


def jpeg_with_gps_exif_and_thumbnail(
    *, make: str = "TestCam", model: str = "X100", width: int = 200, height: int = 100
) -> bytes:
    """JPEG с APP1/Exif: Make/Model, GPSInfoIFDPointer (координаты сами не
    нужны — парсер лишь фиксирует ФАКТ присутствия GPS-тегов, весь
    сегмент вырезается целиком) и встроенной миниатюрой в IFD1."""
    make_bytes = make.encode("ascii") + b"\x00"
    model_bytes = model.encode("ascii") + b"\x00"
    thumb = b"\xff\xd8\xff\xd9"  # минимальный валидный "JPEG" (SOI+EOI)

    make_off, model_off, thumb_off = (
        80,
        80 + len(make_bytes),
        80 + len(make_bytes) + len(model_bytes),
    )

    ifd0_entries = (
        _le16(0x010F)
        + _le16(2)
        + _le32(len(make_bytes))
        + _le32(make_off)
        + _le16(0x0110)
        + _le16(2)
        + _le32(len(model_bytes))
        + _le32(model_off)
        + _le16(0x8825)
        + _le16(4)
        + _le32(1)
        + _le32(999)  # GPS IFD pointer (заглушка адреса)
    )
    ifd0 = _le16(3) + ifd0_entries + _le32(50)  # next IFD -> IFD1 @ 50

    ifd1_entries = (
        _le16(0x0201)
        + _le16(4)
        + _le32(1)
        + _le32(thumb_off)
        + _le16(0x0202)
        + _le16(4)
        + _le32(1)
        + _le32(len(thumb))
    )
    ifd1 = _le16(2) + ifd1_entries + _le32(0)

    tiff = b"II" + _le16(42) + _le32(8) + ifd0 + ifd1 + make_bytes + model_bytes + thumb
    exif_payload = b"Exif\x00\x00" + tiff
    app1 = b"\xff\xe1" + _u16(len(exif_payload) + 2) + exif_payload

    sof0_payload = struct.pack(">BHH", 8, height, width)
    sof0 = b"\xff\xc0" + _u16(len(sof0_payload) + 2) + sof0_payload

    sos_payload = b"\x00\x00\x00\x00"
    sos = b"\xff\xda" + _u16(len(sos_payload) + 2) + sos_payload + b"\x00\x01\x02" + b"\xff\xd9"

    return b"\xff\xd8" + app1 + sof0 + sos


def jpeg_without_exif(*, width: int = 40, height: int = 20) -> bytes:
    """JPEG без APP1 — «своя» фотография без метаданных (телефон без
    геометок/чужой редактор), контур должен пропустить без ошибок."""
    sof0_payload = struct.pack(">BHH", 8, height, width)
    sof0 = b"\xff\xc0" + _u16(len(sof0_payload) + 2) + sof0_payload
    sos_payload = b"\x00\x00\x00\x00"
    sos = b"\xff\xda" + _u16(len(sos_payload) + 2) + sos_payload + b"\x00\x01\x02" + b"\xff\xd9"
    return b"\xff\xd8" + sof0 + sos
