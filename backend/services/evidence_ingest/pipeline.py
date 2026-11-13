"""`evidence_ingest` (ГВ.3, docs/tasks/global-wave.md п.1) — отдельный
процесс поверх общего кодбейза (CLAUDE.md: "периферийные сервисы —
отдельные процессы", тот же принцип, что services/audit_vault и
services/notification_dispatcher), общий деплой-юнит с core, свой воркер.
Здесь — чистые функции пайплайна (без Django/БД): `apps.evidence.services`
— единственный вызывающий, владеет транзакцией и моделью.

hash считается ОТ ОЧИЩЕННЫХ байт (`relay_bytes`, после EXIF-strip для JPEG)
— именно эта версия уходит в релей контрагенту и именно её проверяет
`verify_hash` (apps.evidence.services): «предъявленный файл» — это то, что
контрагент реально получил, не то, что лежало на устройстве загрузившего
до отправки. Внутренне последовательно и не течёт GPS ни в каком виде."""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from .jpeg import NotAJpegError, ingest_jpeg

_JPEG_MIME_TYPES = frozenset({"image/jpeg", "image/jpg"})
# Растровые форматы, для которых миниатюру можно ПОСТРОИТЬ из очищенных байт
# (ADR-125): Pillow декодирует их без внешних плагинов. HEIC/HEIF сюда не входят
# (нет декодера) — у них миниатюры нет, просмотрщик честно показывает «без превью».
_RASTER_MIME_TYPES = frozenset(
    {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff"}
)
_THUMBNAIL_MAX_SIDE = 320
_THUMBNAIL_QUALITY = 80


@dataclass(frozen=True, slots=True)
class IngestResult:
    sha256_hex: str
    relay_bytes: bytes
    thumbnail: bytes | None
    metadata: dict[str, Any]


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate_thumbnail(relay_bytes: bytes, *, mime_type: str) -> bytes | None:
    """Миниатюра, ПОСТРОЕННАЯ из очищенных байт (ADR-125): JPEG ≤ 320px по
    большей стороне, без EXIF (Pillow не переносит метаданные при save без
    `exif=`), ориентация — по EXIF-Orientation до очистки не сохраняется, поэтому
    применяем `exif_transpose` к исходнику, если тег ещё есть. Не декодируемый
    или не растровый файл → `None` (честная деградация, приём не падает)."""
    if mime_type not in _RASTER_MIME_TYPES:
        return None
    try:
        with Image.open(io.BytesIO(relay_bytes)) as source:
            img: Image.Image = ImageOps.exif_transpose(source) or source
            img.thumbnail((_THUMBNAIL_MAX_SIDE, _THUMBNAIL_MAX_SIDE))
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=_THUMBNAIL_QUALITY, optimize=True)
            return out.getvalue()
    except (UnidentifiedImageError, OSError, ValueError):
        return None


def ingest(data: bytes, *, mime_type: str) -> IngestResult:
    """Приём файла (ГВ.3 п.1): SHA-256 + миниатюра + метаданные (размер,
    mime, EXIF-очистка по ADR-045). Метка времени (`TimestampProvider`) —
    забота вызывающей стороны (apps.evidence.services), не пайплайна: это
    факт о МОМЕНТЕ приёма, не о содержимом файла."""
    metadata: dict[str, Any] = {"mime": mime_type, "size": len(data)}
    thumbnail: bytes | None = None
    relay_bytes = data

    if mime_type in _JPEG_MIME_TYPES:
        try:
            result = ingest_jpeg(data)
        except NotAJpegError:
            # Расширение врёт о содержимом — не роняем приём, просто не
            # применяем JPEG-специфичную очистку (честная деградация,
            # тот же приём, что _parse_exif_block ниже по стеку).
            pass
        else:
            relay_bytes = result.clean_bytes
            thumbnail = result.exif.thumbnail
            if result.dimensions is not None:
                metadata["width"] = result.dimensions.width
                metadata["height"] = result.dimensions.height
            metadata["gps_stripped"] = result.exif.gps_present_in_original
            if result.exif.make:
                metadata["camera_make"] = result.exif.make
            if result.exif.model:
                metadata["camera_model"] = result.exif.model

    if thumbnail is None:
        # Встроенного EXIF-превью нет (скриншоты, галерея Android, HEIC→JPEG в
        # браузере — типичные фото с телефона) — до ADR-125 карточка показывала
        # «пустой образ» при живом файле и хеше. Строим превью из тех же байт,
        # что ушли в релей: это не подделка, а производная от того же содержимого.
        thumbnail = generate_thumbnail(relay_bytes, mime_type=mime_type)

    return IngestResult(
        sha256_hex=compute_sha256(relay_bytes),
        relay_bytes=relay_bytes,
        thumbnail=thumbnail,
        metadata=metadata,
    )
