"""Роутер БД для Audit Vault (tech-spec.md §10.3, ADR-038, docs/adr/ADR-065-*.md).

Audit Vault — единственное приложение с собственным подключением к БД
(`audit_vault` psql-инстанс, `settings.DATABASES["audit"]`); все остальные
приложения продолжают жить на "default". Роутер физически исключает
случайную запись доменных моделей в БД Vault (и наоборот) — компрометация
основного приложения не должна давать прямой SQL-доступ к логу (ADR-038).
"""

from __future__ import annotations

from typing import Any

_VAULT_APP_LABEL = "audit_vault"
_VAULT_DB = "audit"
_DEFAULT_DB = "default"


class AuditVaultRouter:
    def db_for_read(self, model: type[Any], **hints: Any) -> str | None:
        return _VAULT_DB if model._meta.app_label == _VAULT_APP_LABEL else None

    def db_for_write(self, model: type[Any], **hints: Any) -> str | None:
        return _VAULT_DB if model._meta.app_label == _VAULT_APP_LABEL else None

    def allow_relation(self, obj1: Any, obj2: Any, **hints: Any) -> bool | None:
        vault1 = obj1._meta.app_label == _VAULT_APP_LABEL
        vault2 = obj2._meta.app_label == _VAULT_APP_LABEL
        if vault1 == vault2:
            return None
        return False

    def allow_migrate(
        self, db: str, app_label: str, model_name: str | None = None, **hints: Any
    ) -> bool | None:
        if app_label == _VAULT_APP_LABEL:
            return db == _VAULT_DB
        return db == _DEFAULT_DB
