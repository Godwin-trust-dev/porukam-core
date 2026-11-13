"""BYO-бэкап в Google Drive пользователя (ГВ.3, docs/tasks/global-wave.md
п.3) — тем же Google-аккаунтом, что вход (ГВ.2, `apps.accounts.models.
SocialLoginAccount`). Интерфейс + фейк для тестов/локалки (тот же приём, что
`apps.accounts.providers.GoogleOAuthProvider`/`FakeGoogleOAuthProvider`);
ниже также РЕАЛЬНАЯ реализация (`RealGoogleDriveBackupProvider`) — продуктовое
решение 13.08.2026 включило Drive-бэкап в октябрьский GLOBAL-запуск
(docs/tasks/Задача_feat_evidence-drive.md), это осознанное и датированное
исключение из общего правила "внешние провайдеры — только интерфейсы +
фейки" (не отменяет его для остальных провайдеров этого приложения).

Единственный scope — `drive.file` (ADR-084): `RealGoogleDriveBackupProvider`
НЕ импортирует модели `apps.accounts` напрямую — только через фасад
`apps.accounts.services.get_drive_access_token` (import-linter)."""

from __future__ import annotations

import json
import uuid as _uuid
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from apps.accounts import services as accounts_services
from apps.accounts.providers import GoogleDriveOAuthProvider
from common import circuit


class GoogleDriveBackupError(Exception):
    """Базовая ошибка бэкапа в Google Drive."""


class GoogleDriveUploadFailedError(GoogleDriveBackupError):
    """Провайдер отказал в загрузке — НЕ блокирует основной поток (ГВ.3:
    «отказ от бэкапа не блокирует ничего — честное предупреждение о риске
    утраты оригиналов»), только помечает `Evidence.backup_status=failed`."""


class GoogleDriveNotConnectedError(GoogleDriveBackupError):
    """К Google-аккаунту не привязан Drive-грант (`apps.accounts.services.
    DriveNotConnectedError`) — подмножество GoogleDriveBackupError: та же
    "не блокирует, честно помечает failed" деградация, что и отказ
    загрузки (docs/tasks/Задача_feat_evidence-drive.md §2.3: «не 500»);
    `backup_failure_reason` доносит до клиента, что нужно (пере)подключить
    Drive — `apps.evidence.services.request_backup` не различает эту ошибку
    и обычный сбой загрузки намеренно, единый путь деградации проще
    дублирующего."""


class GoogleDriveGrantRevokedError(GoogleDriveBackupError):
    """Грант отозван (`apps.accounts.services.DriveGrantRevokedError`) —
    та же деградация, что GoogleDriveNotConnectedError выше."""


@dataclass(frozen=True, slots=True)
class DriveUploadResult:
    file_id: str
    web_view_link: str


class GoogleDriveBackupProvider(Protocol):
    provider_code: str

    def upload(
        self, *, account_sub: str, file_name: str, content: bytes, mime_type: str
    ) -> DriveUploadResult: ...


@dataclass
class FakeGoogleDriveBackupProvider:
    """Детерминированный фейк — тот же приём, что FakeGoogleOAuthProvider:
    `fail` управляется тестом напрямую (не зависит от содержимого файла),
    чтобы проверить путь «бэкап отказал, остальное не пострадало» без
    полагания на недетерминированное поведение внешнего сервиса."""

    provider_code: str = "google_drive_fake"
    fail: bool = False
    uploads: list[DriveUploadResult] = field(default_factory=list)

    def upload(
        self, *, account_sub: str, file_name: str, content: bytes, mime_type: str
    ) -> DriveUploadResult:
        if self.fail:
            circuit.record_failure(self.provider_code)
            raise GoogleDriveUploadFailedError(
                f"фейковый отказ Google Drive для аккаунта {account_sub!r}"
            )
        result = DriveUploadResult(
            file_id=f"fake-drive-file-{len(self.uploads) + 1}",
            web_view_link=f"https://drive.fake.local/file/{len(self.uploads) + 1}",
        )
        self.uploads.append(result)
        circuit.record_success(self.provider_code)
        return result


_DRIVE_UPLOAD_URL = (
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink"
)
_DRIVE_UPLOAD_TIMEOUT_SECONDS = 30


def _multipart_related_body(*, file_name: str, content: bytes, mime_type: str) -> tuple[bytes, str]:
    """Drive API v3 multipart-загрузка (metadata JSON + сырые байты в одном
    теле, `multipart/related`) — НЕ то же самое, что `multipart/form-data`
    (`httpx` files=...), поэтому собирается вручную. `name` — единственное
    поле метаданных: без `parents` файл уходит в корень «Мой диск»
    пользователя, что и требуется (drive.file даёт доступ ровно к этому
    файлу вне зависимости от папки; управление отдельной папкой — вне
    объёма этой задачи, docs/tasks/Задача_feat_evidence-drive.md §3)."""
    boundary = _uuid.uuid4().hex
    metadata = json.dumps({"name": file_name}).encode("utf-8")
    body = (
        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode("ascii")
        + metadata
        + f"\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n".encode("ascii")
        + content
        + f"\r\n--{boundary}--".encode("ascii")
    )
    return body, boundary


@dataclass
class RealGoogleDriveBackupProvider:
    """Единственная реальная (сетевая) реализация Protocol
    GoogleDriveBackupProvider — используется только когда
    `settings.EVIDENCE_DRIVE_PROVIDER=real` (`apps.evidence.api.views`);
    тесты сюда никогда не попадают, только `FakeGoogleDriveBackupProvider`
    выше (docs/tasks/Задача_feat_evidence-drive.md §2.4)."""

    oauth_provider: GoogleDriveOAuthProvider
    provider_code: str = "google_drive_real"

    def upload(
        self, *, account_sub: str, file_name: str, content: bytes, mime_type: str
    ) -> DriveUploadResult:
        try:
            access_token = accounts_services.get_drive_access_token(
                account_sub, provider=self.oauth_provider
            )
        except accounts_services.DriveNotConnectedError as exc:
            raise GoogleDriveNotConnectedError(str(exc)) from exc
        except accounts_services.DriveGrantRevokedError as exc:
            raise GoogleDriveGrantRevokedError(str(exc)) from exc

        body, boundary = _multipart_related_body(
            file_name=file_name, content=content, mime_type=mime_type
        )
        try:
            response = httpx.post(
                _DRIVE_UPLOAD_URL,
                content=body,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": f"multipart/related; boundary={boundary}",
                },
                timeout=_DRIVE_UPLOAD_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            circuit.record_failure(self.provider_code)
            raise GoogleDriveUploadFailedError(f"Drive API отказал: {exc}") from exc

        payload = response.json()
        circuit.record_success(self.provider_code)
        file_id = payload["id"]
        return DriveUploadResult(
            file_id=file_id,
            web_view_link=payload.get(
                "webViewLink", f"https://drive.google.com/file/d/{file_id}/view"
            ),
        )
