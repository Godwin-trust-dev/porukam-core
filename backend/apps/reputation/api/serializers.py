from __future__ import annotations

from typing import Any

from rest_framework import serializers

from ..models import DealFact


class DealCounterpartySerializer(serializers.Serializer[Any]):
    profile_id = serializers.UUIDField()
    role = serializers.ChoiceField(choices=["customer", "contractor"])


class DealFactSerializer(serializers.Serializer[Any]):
    """Один пункт «списка завершённых сделок» (ГВ.4): тип, сфера, период,
    исход, контрагент со ссылкой на его карточку — фронт строит ссылку из
    `counterparty.profile_id` (тот же приём, что `ProfileSerializer`,
    apps.profiles: id без готового href, ссылки на другие карточки нигде
    в API не собираются сервером)."""

    contract_id = serializers.UUIDField()
    contract_type_code = serializers.CharField()
    segment = serializers.CharField()
    sphere_codes = serializers.ListField(child=serializers.CharField())
    period_start = serializers.DateTimeField(allow_null=True)
    period_end = serializers.DateTimeField(allow_null=True)
    completed_at = serializers.DateTimeField(allow_null=True)
    outcome = serializers.CharField()
    milestones_accepted = serializers.IntegerField()
    milestones_rejected = serializers.IntegerField()
    disputes_opened = serializers.IntegerField()
    disputes_resolved = serializers.IntegerField()
    counterparty = DealCounterpartySerializer()

    def to_representation(self, instance: DealFact) -> dict[str, Any]:
        viewer_profile_id = self.context["viewer_profile_id"]
        is_customer = str(instance.customer_profile_id) == str(viewer_profile_id)
        counterparty_id = (
            instance.contractor_profile_id if is_customer else instance.customer_profile_id
        )
        counterparty_role = "contractor" if is_customer else "customer"
        return {
            "contract_id": str(instance.contract_id),
            "contract_type_code": instance.contract_type_code,
            "segment": instance.segment,
            "sphere_codes": instance.sphere_codes,
            "period_start": instance.period_start,
            "period_end": instance.period_end,
            "completed_at": instance.completed_at,
            "outcome": instance.outcome,
            "milestones_accepted": instance.milestones_accepted,
            "milestones_rejected": instance.milestones_rejected,
            "disputes_opened": instance.disputes_opened,
            "disputes_resolved": instance.disputes_resolved,
            "counterparty": {"profile_id": str(counterparty_id), "role": counterparty_role}
            if counterparty_id
            else None,
        }


class CardGroupSerializer(serializers.Serializer[Any]):
    """Пункт блока «состоит в объединениях» (ADR-117 §7): только активные
    членства в ПУБЛИЧНЫХ объединениях, ссылка строится фронтом из id
    (тот же приём, что counterparty.profile_id выше)."""

    id = serializers.UUIDField()
    name = serializers.CharField()
    kind = serializers.CharField()
    handle = serializers.CharField(allow_null=True)


class CountRatioSerializer(serializers.Serializer[Any]):
    """Доля — ВСЕГДА пара «сделано / всего», никогда одно число (макет
    владельца 05.09; domain-model.md §13: единого балла нет). Процент и
    цветовая зона (0–33 / 33–66 / 66–100) считает представление из этой
    пары — сервер не отдаёт ни того, ни другого, иначе «зона» стала бы
    оценкой платформы, а не арифметикой над проверяемыми фактами."""

    done = serializers.IntegerField()
    total = serializers.IntegerField()


class RoleStatsSerializer(serializers.Serializer[Any]):
    """Блок «как исполнитель» / «как заказчик» (ADR-163). Оси СРОКОВ у
    ролей разные и никогда не называются просто «в срок»: у исполнителя —
    `on_time_delivery` («сделано в срок»), у заказчика — `on_time_payment`
    («оплачено в срок») и `prompt_acceptance` («принято без затягивания»).
    Волна 1 отдаёт их пустой парой 0/0 — счётчики наполняет волна 2
    (расширение payload событий + бэкфилл), контракт API при этом не
    меняется."""

    deals = serializers.IntegerField()
    first_time = CountRatioSerializer()
    disputes_free = CountRatioSerializer()
    disputes_opened = serializers.IntegerField()
    disputes_resolved = serializers.IntegerField()
    # Ось сроков ИСПОЛНИТЕЛЯ — этап сдан до дедлайна этапа.
    on_time_delivery = CountRatioSerializer()
    # Оси сроков ЗАКАЗЧИКА — платёж по этапу подтверждён до срока оплаты и
    # приёмка завершена в окне приёмки (не автоприёмкой по тайм-ауту).
    on_time_payment = CountRatioSerializer()
    prompt_acceptance = CountRatioSerializer()
    # ADR-030: гарантийные обращения — ОТДЕЛЬНАЯ метрика, рейтинг задним
    # числом не пересчитывают; поэтому число, а не доля.
    warranty_claims = serializers.IntegerField()


class ByRoleSerializer(serializers.Serializer[Any]):
    contractor = RoleStatsSerializer()
    customer = RoleStatsSerializer()


class SphereStatsSerializer(serializers.Serializer[Any]):
    """Строка раздела «по сферам и ролям». Ключ строки — ПАРА
    (`sphere_code`, `role`): один профиль в одной сфере бывает по обе
    стороны, и складывать эти цифры нельзя. Имя сферы сервер не отдаёт —
    фронт берёт его из `GET /spheres` (тот же приём, что
    `DealFactSerializer.sphere_codes`)."""

    sphere_code = serializers.CharField()
    role = serializers.ChoiceField(choices=["customer", "contractor"])
    deals = serializers.IntegerField()
    first_time = CountRatioSerializer()
    disputes = serializers.IntegerField()
    warranty = serializers.IntegerField()
    # Полоса строки сферы: у исполнителя — «сделано в срок», у заказчика —
    # «оплачено в срок». Одно поле на строку, потому что роль строки уже
    # известна из `role` — подпись выбирает представление.
    on_time = CountRatioSerializer()


class RepeatCounterpartiesSerializer(serializers.Serializer[Any]):
    """«Повторные контрагенты»: `count` из `total` пришли второй раз и
    больше."""

    count = serializers.IntegerField()
    total = serializers.IntegerField()


class ReputationCardSerializer(serializers.Serializer[Any]):
    """`GET /v1/reputation/profiles/{id}/card`. `restricted=True`
    (`link_and_deals`, гость/не-контрагент, ADR-059) — «стартовая
    карточка»: `deals`/`deals_count`/`counterparties_count` не отдаются
    (не только список сделок приватен — производные от него агрегаты
    тоже, иначе частичная утечка через число)."""

    profile_id = serializers.UUIDField()
    kind = serializers.CharField()
    display_name = serializers.CharField(allow_null=True)
    # ADR-103: null — фото нет или зрителю нельзя (deals_only + неполная карточка).
    avatar_url = serializers.CharField(allow_null=True)
    # ADR-093: карточку открывают и по прямой ссылке `profile_id` (сторона
    # договора), не только по `/@handle`. Без публичного идентификатора
    # профиль с `show_name=False` (`display_name=null`) рисовался бы вообще
    # безымянным. `null` — бизнес-профиль юрлица либо пользователь без
    # активного хендла.
    handle = serializers.CharField(allow_null=True)
    profile_age_days = serializers.IntegerField()
    created_at = serializers.DateTimeField()
    restricted = serializers.BooleanField()
    deals_count = serializers.IntegerField(allow_null=True)
    counterparties_count = serializers.IntegerField(allow_null=True)
    deals = DealFactSerializer(many=True)
    # ADR-117 §7: показывается и при restricted=True — членство в публичном
    # объединении публично по построению (как handle).
    groups = CardGroupSerializer(many=True)
    # ADR-122: заявленные сферы деятельности (коды каталога, имена — фронт
    # берёт из GET /spheres, как для сфер сделок).
    sphere_codes = serializers.ListField(
        child=serializers.CharField(), required=False, default=list
    )
    # ADR-163 (макет владельца 05.09). Все агрегаты ниже — ПРОИЗВОДНЫЕ от
    # списка сделок, поэтому при `restricted=True` они уходят пустыми по
    # той же причине, что `deals_count`: иначе стартовая карточка сливала
    # бы историю через цифру. НЕ отдаётся публично объём по валютам и доля
    # защищённых платежей (решение владельца 05.09: «считать можно,
    # показывать другим — нет») — они живут только в приватном
    # `/insights`.
    by_role = ByRoleSerializer(allow_null=True)
    by_sphere = SphereStatsSerializer(many=True)
    disputes_free = CountRatioSerializer(allow_null=True)
    repeat_counterparties = RepeatCounterpartiesSerializer(allow_null=True)
    last_deal_at = serializers.DateTimeField(allow_null=True)


class InsightItemSerializer(serializers.Serializer[Any]):
    """Одна строка раскрытия метрики: конкретный этап (или сделка, если
    метрика сделочная — тогда `milestone_id: null`). `detail` — КОД или
    сырой текст причины из чек-листа, не готовая фраза: перевод и
    склонение живут во фронте (29 локалей), сервер их не собирает."""

    contract_id = serializers.CharField()
    milestone_id = serializers.CharField(allow_null=True)
    title = serializers.CharField(allow_blank=True)
    sphere_code = serializers.CharField(allow_blank=True)
    ok = serializers.BooleanField(allow_null=True)
    detail = serializers.CharField(allow_blank=True)
    happened_at = serializers.DateTimeField(allow_null=True)


class InsightMetricSerializer(serializers.Serializer[Any]):
    """`to_green` — сколько ещё удачных событий подряд нужно, чтобы доля
    дотянулась до зелёной зоны; `null` — уже зелёная либо считать нечего.
    Сам порог остаётся правилом ПРЕДСТАВЛЕНИЯ (ADR-163 §3) — сервер отдаёт
    только это производное число, не процент и не цвет."""

    code = serializers.CharField()
    role = serializers.CharField(allow_blank=True)
    done = serializers.IntegerField()
    total = serializers.IntegerField()
    to_green = serializers.IntegerField(allow_null=True)
    items = InsightItemSerializer(many=True)


class InsightRecentSerializer(serializers.Serializer[Any]):
    deals = serializers.IntegerField()
    counterparties = serializers.IntegerField()
    rejections = serializers.IntegerField()


class InsightMoneySerializer(serializers.Serializer[Any]):
    """Деньги — всегда парой, сумма строкой (CLAUDE.md)."""

    amount = serializers.CharField()
    currency = serializers.CharField()


class InsightHiddenSerializer(serializers.Serializer[Any]):
    """«Считается, но не показывается другим» (ADR-163 §4). Объём —
    СПИСКОМ по валютам: складывать разные валюты нельзя, курса у платформы
    нет и быть не должно."""

    volume = InsightMoneySerializer(many=True)
    protected_payments = CountRatioSerializer()


class ReputationInsightsSerializer(serializers.Serializer[Any]):
    """`GET /v1/reputation/profiles/{id}/insights` — ПРИВАТНО, только
    владелец профиля (403 всем остальным, включая контрагента завершённой
    сделки). Отдельный документ от карточки: ADR-163 §8."""

    profile_id = serializers.CharField()
    generated_at = serializers.DateTimeField()
    deals = serializers.IntegerField()
    counterparties = serializers.IntegerField()
    recent = InsightRecentSerializer()
    metrics = InsightMetricSerializer(many=True)
    hidden = InsightHiddenSerializer()
