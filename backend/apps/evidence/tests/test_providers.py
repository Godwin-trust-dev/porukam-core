"""RealGoogleDriveBackupProvider — сетевой уровень изолирован моком
`httpx.post` (тесты НИКОГДА не ходят в реальный Google, docs/tasks/
Задача_feat_evidence-drive.md §2.4). Грант/access-токен здесь не в фокусе
(см. apps.evidence.tests.test_services) — здесь только сама заливка."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest

from apps.accounts.providers import FakeGoogleDriveOAuthProvider
from apps.evidence.providers import (
    GoogleDriveUploadFailedError,
    RealGoogleDriveBackupProvider,
    _multipart_related_body,
)

pytestmark = pytest.mark.django_db


def _connected_provider(account_sub: str) -> RealGoogleDriveBackupProvider:
    from apps.accounts import services as accounts_services
    from apps.accounts.models import SocialLoginAccount, User

    user = User.objects.create(
        trust_id=f"trust-{account_sub}", verification_level=User.VerificationLevel.BASIC
    )
    SocialLoginAccount.objects.create(
        user=user, provider="google", sub=account_sub, email="a@x.com"
    )
    oauth_provider = FakeGoogleDriveOAuthProvider()
    _url, state = accounts_services.build_drive_connect_authorize_url(user, provider=oauth_provider)
    accounts_services.complete_drive_connect(
        user=user, code=f"code-{account_sub}", state=state, provider=oauth_provider
    )
    return RealGoogleDriveBackupProvider(oauth_provider=oauth_provider)


def test_multipart_related_body_contains_metadata_and_content():
    body, boundary = _multipart_related_body(
        file_name="photo.jpg", content=b"\xff\xd8\xff\xd9", mime_type="image/jpeg"
    )
    assert boundary.encode() in body
    assert b'"name": "photo.jpg"' in body
    assert b"\xff\xd8\xff\xd9" in body
    assert b"Content-Type: image/jpeg" in body


def test_upload_success_returns_file_id_and_link():
    provider = _connected_provider("sub-prov-1")
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {
        "id": "drive-file-123",
        "webViewLink": "https://drive.google.com/file/d/drive-file-123/view",
    }
    with patch("apps.evidence.providers.httpx.post", return_value=mock_response) as post:
        result = provider.upload(
            account_sub="sub-prov-1",
            file_name="photo.jpg",
            content=b"bytes",
            mime_type="image/jpeg",
        )
    assert result.file_id == "drive-file-123"
    assert result.web_view_link == "https://drive.google.com/file/d/drive-file-123/view"
    call_kwargs = post.call_args.kwargs
    assert call_kwargs["headers"]["Authorization"].startswith("Bearer fake-drive-access-refreshed-")


def test_upload_network_failure_raises_upload_failed_error():
    provider = _connected_provider("sub-prov-2")
    with (
        patch(
            "apps.evidence.providers.httpx.post",
            side_effect=httpx.ConnectError("boom"),
        ),
        pytest.raises(GoogleDriveUploadFailedError),
    ):
        provider.upload(
            account_sub="sub-prov-2",
            file_name="photo.jpg",
            content=b"bytes",
            mime_type="image/jpeg",
        )
