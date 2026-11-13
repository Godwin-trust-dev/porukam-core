"""services/evidence_ingest/pipeline.py — ГВ.3 (docs/tasks/global-wave.md
п.1): приём файла -> хеш + миниатюра + метаданные."""

from __future__ import annotations

import hashlib
import io

from PIL import Image

from apps.evidence.tests._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif
from services.evidence_ingest import pipeline


def test_ingest_hash_matches_relayed_bytes_not_raw_original():
    """Хеш — от ОЧИЩЕННЫХ байт (то, что реально уходит в релей), не от
    исходных с EXIF: «сверка предъявленного файла» сравнивает на равных
    (etap-4.md/ГВ.3 п.2)."""
    data = jpeg_with_gps_exif_and_thumbnail()
    result = pipeline.ingest(data, mime_type="image/jpeg")
    assert result.sha256_hex == hashlib.sha256(result.relay_bytes).hexdigest()
    assert result.sha256_hex != hashlib.sha256(data).hexdigest()


def test_ingest_metadata_never_carries_raw_exif_or_gps():
    data = jpeg_with_gps_exif_and_thumbnail()
    result = pipeline.ingest(data, mime_type="image/jpeg")
    assert result.metadata["gps_stripped"] is True
    assert "gps" not in {k.lower() for k in result.metadata}
    dump = repr(result.metadata)
    assert "999" not in dump  # заглушка-офсет GPS IFD никак не всплывает


def test_ingest_non_jpeg_mime_passes_through_without_crash():
    result = pipeline.ingest(b"plain bytes, not an image", mime_type="application/pdf")
    assert result.thumbnail is None
    assert result.metadata == {"mime": "application/pdf", "size": len(b"plain bytes, not an image")}
    assert result.sha256_hex == hashlib.sha256(b"plain bytes, not an image").hexdigest()


def test_ingest_jpeg_disguised_as_something_else_degrades_gracefully():
    """Расширение/mime врёт (не настоящий JPEG) — приём не падает, просто
    без JPEG-специфичной очистки (честная деградация)."""
    result = pipeline.ingest(b"not really a jpeg", mime_type="image/jpeg")
    assert result.thumbnail is None
    assert result.sha256_hex == hashlib.sha256(b"not really a jpeg").hexdigest()


def test_compute_sha256_is_deterministic():
    assert pipeline.compute_sha256(b"abc") == pipeline.compute_sha256(b"abc")
    assert pipeline.compute_sha256(b"abc") != pipeline.compute_sha256(b"abd")


def test_ingest_without_exif_still_reports_dimensions():
    data = jpeg_without_exif(width=64, height=48)
    result = pipeline.ingest(data, mime_type="image/jpeg")
    assert result.metadata["width"] == 64
    assert result.metadata["height"] == 48
    assert result.metadata["gps_stripped"] is False


def _real_image(fmt: str, size: tuple[int, int] = (1200, 800), *, mode: str = "RGB") -> bytes:
    """Настоящее декодируемое изображение (не байтовая заглушка фикстур)."""
    out = io.BytesIO()
    Image.new(mode, size, color=(200, 120, 40) if mode == "RGB" else 128).save(out, format=fmt)
    return out.getvalue()


def test_ingest_builds_thumbnail_when_jpeg_has_no_embedded_preview():
    """ADR-125: фото без EXIF-превью (скриншот, галерея Android) раньше давало
    `thumbnail=None` → «пустой образ» в карточке при живом файле и хеше."""
    data = _real_image("JPEG")
    result = pipeline.ingest(data, mime_type="image/jpeg")
    assert result.thumbnail is not None
    with Image.open(io.BytesIO(result.thumbnail)) as thumb:
        assert thumb.format == "JPEG"
        assert max(thumb.size) <= 320
        assert thumb.getexif() == {}  # превью без метаданных


def test_ingest_builds_thumbnail_for_png_and_webp():
    for fmt, mime in (("PNG", "image/png"), ("WEBP", "image/webp")):
        result = pipeline.ingest(_real_image(fmt, mode="RGB"), mime_type=mime)
        assert result.thumbnail is not None, fmt
        with Image.open(io.BytesIO(result.thumbnail)) as thumb:
            assert thumb.format == "JPEG"
            assert max(thumb.size) <= 320


def test_ingest_png_with_alpha_converts_to_rgb_thumbnail():
    out = io.BytesIO()
    Image.new("RGBA", (500, 300), color=(10, 20, 30, 128)).save(out, format="PNG")
    result = pipeline.ingest(out.getvalue(), mime_type="image/png")
    assert result.thumbnail is not None
    with Image.open(io.BytesIO(result.thumbnail)) as thumb:
        assert thumb.mode == "RGB"


def test_ingest_keeps_embedded_exif_thumbnail_when_present():
    """Встроенное превью камеры остаётся источником №1 — генерация только фолбэк."""
    data = jpeg_with_gps_exif_and_thumbnail()
    result = pipeline.ingest(data, mime_type="image/jpeg")
    assert result.thumbnail == b"\xff\xd8\xff\xd9"


def test_ingest_thumbnail_does_not_change_hash_or_relay_bytes():
    data = _real_image("JPEG")
    result = pipeline.ingest(data, mime_type="image/jpeg")
    assert result.sha256_hex == hashlib.sha256(result.relay_bytes).hexdigest()


def test_ingest_undecodable_image_bytes_degrade_to_no_thumbnail():
    result = pipeline.ingest(b"\x89PNG not really", mime_type="image/png")
    assert result.thumbnail is None


def test_ingest_heic_has_no_thumbnail_without_decoder():
    result = pipeline.ingest(b"\x00\x00\x00\x18ftypheic", mime_type="image/heic")
    assert result.thumbnail is None
