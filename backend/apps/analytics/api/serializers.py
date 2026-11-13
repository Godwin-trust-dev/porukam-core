"""Сериализаторы приложения аналитики.

Ответы метрик сериализаторов не имеют сознательно: селекторы отдают уже
готовый плоский JSON той же формы, что SQL-мост (§9.3), и промежуточный
сериализатор здесь только расходился бы с ним при каждой правке.
Сериализатор нужен ровно там, где есть ВВОД, — на событии конструктора.
"""

from __future__ import annotations

from rest_framework import serializers

from ..models import ConstructorStepEvent, InstallEvent


class ConstructorStepSerializer(serializers.Serializer[dict[str, object]]):
    """Узкий слой §8.1: никаких персональных данных, только форма.

    `user`/`ip`/значения полей формы здесь отсутствуют не по забывчивости —
    их появление превратило бы узкий слой в клиентский трекинг, от которого
    §9.4 отказывается сознательно."""

    step_code = serializers.CharField(max_length=64)
    action = serializers.ChoiceField(choices=ConstructorStepEvent.Action.choices)
    contract_id = serializers.UUIDField(required=False, allow_null=True)


class InstallEventSerializer(serializers.Serializer[dict[str, object]]):
    """Второй и последний ВВОД приложения (ADR-171) — воронка установки.

    Все поля с закрытым набором значений: клиент не может прислать ни
    произвольный вид события, ни строку User-Agent, ни что бы то ни было
    ещё. Платформа приходит уже грубой корзиной — сузить её до устройства
    нельзя ни здесь, ни в модели.

    `user_id` в теле НЕТ намеренно: пользователь берётся из токена во вьюхе,
    иначе кто угодно приписал бы установку чужому аккаунту."""

    kind = serializers.ChoiceField(choices=InstallEvent.Kind.choices)
    platform = serializers.ChoiceField(
        choices=InstallEvent.Platform.choices, required=False, default=InstallEvent.Platform.OTHER
    )
    display_mode = serializers.ChoiceField(
        choices=InstallEvent.DisplayMode.choices,
        required=False,
        default=InstallEvent.DisplayMode.BROWSER,
    )
    # `source` — имя поля НА ПРОВОДЕ, и менять его ради типов нельзя: оно
    # уже описано в ADR-171 и в мок-хендлере веба. У `serializers.Field` есть
    # собственный атрибут `source` (маппинг на модель), поэтому объявление
    # поля с таким именем красит mypy — на поведение DRF это не влияет:
    # объявленные поля живут в `fields`, а не в атрибутах экземпляра.
    source = serializers.ChoiceField(  # type: ignore[assignment]
        choices=InstallEvent.Source.choices, required=False, default=InstallEvent.Source.UNKNOWN
    )
