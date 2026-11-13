"""Переписка по договору (ADR-112) — bounded context `messaging`.

Сообщение привязано к договору (не к паре пользователей): переписка — часть
доказательной базы сделки (tech-spec §4, правка ADR-112) и потенциальное
доказательство в споре. Поэтому append-only: редактирования и удаления нет —
как у юрзначимых сущностей (CLAUDE.md: мягкого удаления нет), хотя само
сообщение юрзначимым не является (юрканал уведомлений — ЛК, ADR-057).

Сторон у договора ровно две — состояние прочтения выражается одним
`read_at`: момент, когда переписку открыл НЕ отправитель (контрагент).
"""

from __future__ import annotations

from django.db import models

from common.uuid7 import uuid7


class Message(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    contract = models.ForeignKey(
        "contracts.Contract", related_name="messages", on_delete=models.CASCADE
    )
    sender_profile = models.ForeignKey(
        "profiles.Profile", related_name="+", on_delete=models.PROTECT
    )
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    # Момент прочтения контрагентом (вторая сторона открыла переписку);
    # NULL — ещё не прочитано. Отправитель своё сообщение «читал» по определению.
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "message"
        verbose_name = "сообщение"
        verbose_name_plural = "сообщения"
        indexes = [models.Index(fields=["contract", "created_at"])]

    def __str__(self) -> str:
        return f"{self.contract_id}:{self.id}"
