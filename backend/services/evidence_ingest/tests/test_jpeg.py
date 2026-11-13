"""services/evidence_ingest/jpeg.py — ГВ.3 (docs/tasks/global-wave.md):
разбор пуст-Python. Не требует БД — чистые функции."""

from __future__ import annotations

import pytest

from apps.evidence.tests._fixtures import jpeg_with_gps_exif_and_thumbnail, jpeg_without_exif
from services.evidence_ingest.jpeg import NotAJpegError, ingest_jpeg


def test_ingest_jpeg_strips_exif_completely():
    data = jpeg_with_gps_exif_and_thumbnail()
    result = ingest_jpeg(data)
    assert b"Exif" not in result.clean_bytes
    assert b"TestCam" not in result.clean_bytes
    assert b"X100" not in result.clean_bytes


def test_ingest_jpeg_detects_gps_presence_without_leaking_coordinates():
    data = jpeg_with_gps_exif_and_thumbnail()
    result = ingest_jpeg(data)
    assert result.exif.gps_present_in_original is True
    # Сама GPS IFD (или что-либо из неё) нигде не всплывает в очищенном
    # потоке — только факт присутствия зафиксирован в сводке.
    assert b"\x88\x25" not in result.clean_bytes  # tag 0x8825 как байты


def test_ingest_jpeg_extracts_embedded_thumbnail():
    data = jpeg_with_gps_exif_and_thumbnail()
    result = ingest_jpeg(data)
    assert result.exif.thumbnail == b"\xff\xd8\xff\xd9"


def test_ingest_jpeg_extracts_make_and_model():
    data = jpeg_with_gps_exif_and_thumbnail(make="Acme", model="Zoom-1")
    result = ingest_jpeg(data)
    assert result.exif.make == "Acme"
    assert result.exif.model == "Zoom-1"


def test_ingest_jpeg_reads_dimensions():
    data = jpeg_with_gps_exif_and_thumbnail(width=640, height=480)
    result = ingest_jpeg(data)
    assert result.dimensions is not None
    assert result.dimensions.width == 640
    assert result.dimensions.height == 480


def test_ingest_jpeg_without_exif_has_no_thumbnail_or_gps():
    data = jpeg_without_exif()
    result = ingest_jpeg(data)
    assert result.exif.thumbnail is None
    assert result.exif.gps_present_in_original is False
    assert result.clean_bytes == data  # нечего вырезать — поток не менялся


def test_ingest_jpeg_clean_bytes_remain_valid_jpeg_boundaries():
    data = jpeg_with_gps_exif_and_thumbnail()
    result = ingest_jpeg(data)
    assert result.clean_bytes[:2] == b"\xff\xd8"
    assert result.clean_bytes[-2:] == b"\xff\xd9"


def test_ingest_jpeg_rejects_non_jpeg():
    with pytest.raises(NotAJpegError):
        ingest_jpeg(b"not a jpeg at all")
