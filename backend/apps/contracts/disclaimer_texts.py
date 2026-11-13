"""Л.1 (docs/tasks/l10n-wave.md, п.3, уточнение к доку 32 v1.2) — текст
дисклеймера в ответе `/sign`, показывается ТОЛЬКО когда
`SignatureRequest.locale != ContractVersion.canonical_language` (api/views.py
`SignatureRequestSignView`). Формулировка — по уточнению v1.2 буквально:
«Это автоматический перевод. Официальный текст договора — {official_language}»
— без слова «канонический» (API-тексты используют «official», не «canonical»,
CLAUDE.md — не юридическая, а продуктовая формулировка «for convenience only»
уступила место точной по уточнению).

Тот же приём, что `common/api/error_texts.py::ERROR_TITLES_EN` (реестр по
ключу, не по вызову): здесь ключ — locale, не code. Сегодня backend-i18n
покрывает только ru/en (`common/i18n.py::SUPPORTED_LOCALES`) — Л.2 (языковые
пакеты) уже влита в эту ветку, но подключение l10n-пакетов к дисклеймеру —
не в скоупе Л.1 (пакеты пока не несут `legal.disclaimer`, см.
`l10n/README.md`), поэтому для нерегистрированной locale подписанта честно
падаем на EN, а не пытаемся угадать/сгенерировать текст на лету."""

from __future__ import annotations

DISCLAIMER_TEXTS: dict[str, str] = {
    "en": (
        "This is an automatic translation. The official text of the "
        "contract is {official_language}."
    ),
    "ru": "Это автоматический перевод. Официальный текст договора — {official_language}.",
}


def get_disclaimer_text(*, shown_locale: str, official_language: str) -> str:
    template = DISCLAIMER_TEXTS.get(shown_locale, DISCLAIMER_TEXTS["en"])
    return template.format(official_language=official_language)
