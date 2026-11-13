"""Нормализация загружаемых изображений (ADR-103/115/117) — общие чистые
функции над байтами, вынесенные из apps/profiles/images.py, чтобы логотип
объединения (apps.social) переиспользовал пайплайн без импорта apps.profiles.

Любой исходник превращается в WebP-варианты БЕЗ метаданных (EXIF/GPS
отбрасываются: Pillow при `save` без параметра `exif` их не пишет);
ориентация из EXIF применяется к пикселям; анимация/многостраничность —
первый кадр; прозрачность — на белый фон. Здесь ни БД, ни хранилища —
условия вызова (права, лимит байт запроса) в services/api потребителей."""

from __future__ import annotations

import io
from collections.abc import Mapping
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL import Image as PILImage

WEBP_CONTENT_TYPE = "image/webp"
_WEBP_QUALITY = 80


class InvalidImageError(ValueError):
    """Байты — не изображение, повреждены или превышают лимит пикселей."""


def _sanitize(content: bytes, *, max_pixels: int) -> PILImage.Image:
    from PIL import Image, ImageOps, UnidentifiedImageError

    # Декомпрессионная бомба — порог настройкой, не константой (ADR-103 п.7):
    # размер известен из заголовка ДО декодирования (`open` ленив), проверяем
    # сами и только потом `load()`; встроенный порог Pillow отключаем, чтобы
    # не было двойной (и предупреждающей) проверки.
    Image.MAX_IMAGE_PIXELS = None
    try:
        opened = Image.open(io.BytesIO(content))
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise InvalidImageError("файл не распознан как изображение") from exc
    width, height = opened.size
    if width < 1 or height < 1:
        raise InvalidImageError("пустое изображение")
    if width * height > max_pixels:
        raise InvalidImageError("изображение слишком большое по пикселям")
    try:
        opened.load()
    except (OSError, ValueError) as exc:
        raise InvalidImageError("изображение повреждено") from exc
    image: Image.Image = opened

    # Ориентация из EXIF применяется к пикселям, сам EXIF дальше не едет.
    image = ImageOps.exif_transpose(image) or image
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    if image.mode == "RGBA":
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.getchannel("A"))
        image = background
    return image


def process_square_webp(
    content: bytes, *, sizes: tuple[int, ...], max_pixels: int
) -> Mapping[int, bytes]:
    """Квадратный кроп по центру (аватар ADR-103, логотип ADR-117):
    {размер_px: webp-байты}. Бросает InvalidImageError."""
    from PIL import Image, ImageOps

    image = _sanitize(content, max_pixels=max_pixels)
    square = ImageOps.fit(image, (min(image.size), min(image.size)), centering=(0.5, 0.5))

    result: dict[int, bytes] = {}
    for size in sizes:
        variant = square.resize((size, size), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        variant.save(buffer, format="WEBP", quality=_WEBP_QUALITY, method=4)
        result[size] = buffer.getvalue()
    return result


def process_fit_webp(
    content: bytes, *, sizes: tuple[int, ...], max_pixels: int
) -> Mapping[int, bytes]:
    """Без кропа, ужатие по большей стороне (портфолио ADR-115) —
    исходные пропорции сохраняются."""
    from PIL import Image

    image = _sanitize(content, max_pixels=max_pixels)
    result: dict[int, bytes] = {}
    for size in sizes:
        variant = image.copy()
        variant.thumbnail((size, size), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        variant.save(buffer, format="WEBP", quality=_WEBP_QUALITY, method=4)
        result[size] = buffer.getvalue()
    return result
