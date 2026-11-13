"""ГВ.3 (docs/tasks/global-wave.md): `MilestoneEvidenceListCreateView`
переехала на apps.evidence (apps/evidence/api/views.py) — тот же URL
(`/milestones/{id}/evidence`), настоящий контур вместо файлов-заглушки
Э4.6. `apps.documents.services.upload_document`/`selectors` остаются
рабочими (задел под исходную ответственность tech-spec.md §4 — закрывающие
документы), просто больше не выведены в API этой веткой."""

from __future__ import annotations
