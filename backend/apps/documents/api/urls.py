from __future__ import annotations

# ГВ.3 (docs/tasks/global-wave.md): `GET/POST /milestones/{id}/evidence`
# переехал на apps.evidence (см. apps/evidence/api/urls.py) — тот же адрес,
# настоящий контур вместо файлов-заглушки Э4.6. apps.documents больше не
# регистрирует маршрутов, но модель/сервис остаются (см. apps/documents/
# models.py) для исходной ответственности tech-spec.md §4 (закрывающие
# документы) — задел, не мёртвый код.
urlpatterns: list[object] = []
