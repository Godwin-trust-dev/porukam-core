"""Нормализация фото профиля (ADR-103) и портфолио (ADR-115): тонкие
обёртки над общими функциями common/images.py (вынесены туда в ADR-117 §8
для логотипов объединений). Поведение прежнее: аватар — два квадратных
WebP 256/64 без метаданных, портфолио — 1280/320 без кропа.

`InvalidAvatarImageError` — алиас common.images.InvalidImageError (НЕ
подкласс: и старые except-ы этого приложения, и общий пайплайн должны
ловить ровно один и тот же класс)."""

from __future__ import annotations

from collections.abc import Mapping

from django.conf import settings

from common.images import (
    WEBP_CONTENT_TYPE,
    InvalidImageError,
    process_fit_webp,
    process_square_webp,
)

AVATAR_SIZES: tuple[int, ...] = (256, 64)
# Портфолио (ADR-115): большая для просмотра + миниатюра сетки; аспект
# сохраняется (в отличие от квадратного аватара).
PORTFOLIO_SIZES: tuple[int, ...] = (1280, 320)
AVATAR_CONTENT_TYPE = WEBP_CONTENT_TYPE

InvalidAvatarImageError = InvalidImageError


def process_avatar(content: bytes) -> Mapping[int, bytes]:
    """Возвращает {размер_px: webp-байты}. Бросает InvalidAvatarImageError."""
    return process_square_webp(
        content, sizes=AVATAR_SIZES, max_pixels=settings.PROFILE_AVATAR_MAX_SOURCE_PIXELS
    )


def process_portfolio_image(content: bytes) -> Mapping[int, bytes]:
    """Портфолио (ADR-115): та же санитария, что у аватара (EXIF в пиксели
    и прочь, первый кадр, белый фон), но БЕЗ квадратного кропа."""
    return process_fit_webp(
        content, sizes=PORTFOLIO_SIZES, max_pixels=settings.PROFILE_AVATAR_MAX_SOURCE_PIXELS
    )
