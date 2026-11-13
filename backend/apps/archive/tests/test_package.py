"""Доказательный пакет (ADR-139): детерминизм, SHA256SUMS под `sha256sum -c`,
цепочный путь до корня чекпойнта (verify.py из самого пакета), чужие звенья
только хешем, состав files.zip."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import shutil
import subprocess
import sys
import zipfile

import httpx
import pytest

from apps.archive import package, services
from apps.archive.storage import FakeArchiveObjectStore
from services.audit_vault import checkpoint as checkpoint_module
from services.audit_vault import providers as vault_providers
from services.audit_vault.models import AuditEntry
from services.audit_vault.storage import FakeCheckpointObjectStore
from services.audit_vault.tests.fake_tsa import FakeTsaServer, transport_for

from ._helpers import RecordingEmailProvider, checkpoint, make_deal, relay_all, upload

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _export(contract, contractor, *, store, **options):
    return services.request_export(contract, user=contractor, **options)


def _unzip(data: bytes, into) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        archive.extractall(into)


def test_package_bytes_are_deterministic():
    contract, milestone, _customer, contractor, store = make_deal("p1")
    upload(contract, milestone, contractor, store, with_thumbnail=True)
    relay_all()
    checkpoint()
    export = _export(contract, contractor, store=store)

    first = services.build_artifacts(export, evidence_store=store)
    second = services.build_artifacts(export, evidence_store=store)

    assert first[0] == second[0]  # package.zip
    assert first[1] == second[1]  # files.zip
    assert first[3] == second[3]  # SHA256SUMS


def test_sha256sums_pass_coreutils_and_verify_py(tmp_path):
    contract, milestone, customer, contractor, store = make_deal("p2")
    upload(contract, milestone, contractor, store, name="before.jpg", with_thumbnail=True)
    upload(contract, milestone, customer, store, name="after.jpg")
    relay_all()
    cp = checkpoint()
    assert cp is not None
    export = _export(contract, contractor, store=store)
    package_zip, files_zip, record, sums, count = services.build_artifacts(
        export, evidence_store=store
    )
    assert count == 2
    _unzip(package_zip, tmp_path)
    _unzip(files_zip, tmp_path)

    names = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file())
    assert "manifest.json" in names and "SHA256SUMS" in names and "README.txt" in names
    assert "index.html" in names and "verify.py" in names and "verify.ps1" in names
    assert f"checkpoint-{cp.pk}.json" in names
    assert any(n.startswith("files/") and n.endswith("_before.jpg") for n in names)
    assert any(n.startswith("thumbnails/") for n in names)

    if shutil.which("sha256sum"):
        result = subprocess.run(
            ["sha256sum", "-c", "SHA256SUMS"], cwd=tmp_path, capture_output=True, text=True
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "FAILED" not in result.stdout
    result = subprocess.run(
        [sys.executable, "verify.py"], cwd=tmp_path, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "RESULT: OK" in result.stdout
    assert f"chain checkpoint-{cp.pk}" in result.stdout


def test_chain_path_reaches_checkpoint_root_and_hides_foreign_entries():
    contract, milestone, _customer, contractor, store = make_deal("p3")
    evidence = upload(contract, milestone, contractor, store)
    relay_all()
    # Чужая сделка в том же диапазоне чекпойнта — её содержимое в пакет не
    # попадает, только хеши звеньев.
    other, other_ms, _oc, other_contractor, _os = make_deal("p4")
    upload(other, other_ms, other_contractor, store, name="secret.jpg")
    relay_all()
    cp = checkpoint()
    assert cp is not None

    export = _export(contract, contractor, store=store)
    _pkg, _files, record, _sums, _n = services.build_artifacts(export, evidence_store=store)

    entry = record["evidence"][0]["audit"]
    assert entry["checkpoint_id"] == cp.pk
    chain = record["audit_chains"][f"checkpoint-{cp.pk}"]
    assert chain["root"] == cp.digest
    assert chain["links"][-1]["this_hash"] == cp.digest
    assert chain["links"][0]["seq"] == entry["entry_seq"]
    disclosed = [link for link in chain["links"] if link["canonical"] is not None]
    hidden = [link for link in chain["links"] if link["canonical"] is None]
    assert disclosed and hidden
    own_seq = AuditEntry.objects.get(
        action="evidence.received", target_type="evidence", target_id=str(evidence.id)
    ).seq
    assert any(link["seq"] == own_seq for link in disclosed)
    dumped = json.dumps(record, ensure_ascii=False)
    assert "secret.jpg" not in dumped
    assert str(other.id) not in dumped
    # Раскрытые звенья пересчитываются офлайн.
    for link in disclosed:
        material = (link["prev_hash"] + link["canonical"]).encode("ascii")
        assert hashlib.sha256(material).hexdigest() == link["this_hash"]


def test_manifest_only_has_no_files_zip_and_evidence_before_checkpoint_pending():
    contract, milestone, _customer, contractor, store = make_deal("p5")
    upload(contract, milestone, contractor, store)
    relay_all()
    export = _export(contract, contractor, store=store, include_originals=False, manifest_only=True)
    _pkg, files_zip, record, sums, _n = services.build_artifacts(export, evidence_store=store)
    assert files_zip is None
    assert record["evidence"][0]["original_included"] is False
    assert record["evidence"][0]["audit"]["note"] == "checkpoint_pending"
    assert "files/" not in sums


def test_build_export_stores_encrypted_and_delivers_to_both_parties():
    contract, milestone, customer, contractor, store = make_deal("p6")
    upload(contract, milestone, contractor, store, with_thumbnail=True)
    relay_all()
    checkpoint()
    export = _export(contract, contractor, store=store)
    archive_store = FakeArchiveObjectStore()
    provider = RecordingEmailProvider()

    services.build_export(
        export, evidence_store=store, archive_store=archive_store, email_provider=provider
    )
    export.refresh_from_db()
    assert export.status == "ready"
    assert export.files_state == "available"
    raw = archive_store.objects[export.package_key]
    assert not raw.startswith(b"PK")  # шифротекст, не zip
    assert services.read_artifact(export, kind="package", archive_store=archive_store).startswith(
        b"PK"
    )
    assert services.read_artifact(export, kind="files", archive_store=archive_store).startswith(
        b"PK"
    )
    roles = sorted((link.kind, link.party_role) for link in export.links.all())
    assert roles == [
        ("files", "contractor"),
        ("files", "customer"),
        ("package", "contractor"),
        ("package", "customer"),
    ]
    assert {u.id for u, _ in provider.messages} == {customer.id, contractor.id}
    for _user, message in provider.messages:
        attachments = message["attachments"]
        assert attachments[0]["filename"].endswith("-package.zip")
        assert message["payload"]["package_attached"] is True
        assert message["payload"]["files_url"].startswith("http://localhost:5173/a/")


def test_attested_checkpoint_timestamp_files_are_in_package(tmp_path):
    """ADR-135 + ADR-139: у заверенного (RFC 3161) чекпойнта в package.zip
    лежат те же файлы, что отдаёт `verify_checkpoint_timestamps --export-dir`
    — `.tsq`/`.tsr`/`.chain.pem`/`.<ocsp|crl>.der` на каждую метку, а README
    содержит команду `openssl ts -verify` на них. Фейковый чекпойнт
    (`FakeTimestampAuthority`) файлов не даёт — проверять там нечего."""
    hosts = ["one.test", "two.test"]
    servers = {host: FakeTsaServer(name=host, host=host) for host in hosts}
    authority = vault_providers.Rfc3161TimestampAuthority(
        endpoints=[f"http://{h}/tsr" for h in hosts],
        quorum=2,
        timeout=1.0,
        client_factory=lambda: httpx.Client(transport=transport_for(servers)),
    )
    contract, milestone, customer, contractor, store = make_deal("p7")
    upload(contract, milestone, contractor, store, name="before.jpg")
    relay_all()
    cp = checkpoint_module.compute_daily_checkpoint(
        provider=authority, store=FakeCheckpointObjectStore()
    )
    assert cp is not None and cp.tsa_status == "attested"

    export = _export(contract, contractor, store=store)
    package_zip, _files_zip, record, _sums, _count = services.build_artifacts(
        export, evidence_store=store
    )
    _unzip(package_zip, tmp_path)
    names = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file())

    directory = f"checkpoint-{cp.pk}"
    assert f"{directory}.json" in names
    for host_index, host in enumerate(hosts):
        stem = f"{directory}/{host_index:02d}-{host}"
        assert f"{stem}.tsq" in names and f"{stem}.tsr" in names, names
        assert f"{stem}.chain.pem" in names, names
        assert any(n.startswith(f"{stem}.") and n.endswith(".der") for n in names), names
    # Байты метки — те же, что в Vault (без перекодирования).
    tsr = (tmp_path / directory / "00-one.test.tsr").read_bytes()
    assert tsr == base64.b64decode(cp.timestamps[0]["tsr_b64"])
    readme = (tmp_path / "README.txt").read_text(encoding="utf-8")
    assert (
        f"openssl ts -verify -queryfile {directory}/00-one.test.tsq -in {directory}/00-one.test.tsr"
        in readme
    )


def test_verify_ps1_is_in_package_and_covered_by_sha256sums(tmp_path):
    """`verify.ps1` — такой же файл пакета, как остальные: лежит в package.zip
    и покрыт SHA256SUMS (иначе «проверьте пакет скриптом из пакета» — дыра)."""
    contract, milestone, _customer, contractor, store = make_deal("p8")
    upload(contract, milestone, contractor, store)
    relay_all()
    export = _export(contract, contractor, store=store)
    package_zip, _files_zip, _record, sums, _n = services.build_artifacts(
        export, evidence_store=store
    )
    _unzip(package_zip, tmp_path)

    script = tmp_path / "verify.ps1"
    body = script.read_bytes()
    assert body.startswith(b"\xef\xbb\xbf"), "нужен BOM: PowerShell 5.1 иначе портит кириллицу"
    digest = hashlib.sha256(body).hexdigest()
    assert f"{digest}  verify.ps1\n" in sums
    text = body.decode("utf-8-sig")
    assert "Get-FileHash" in text and "SHA256SUMS" in text
    assert "exit 1" in text and "FAILED" in text and "MISSING" in text
    # Скобки и кавычки сбалансированы (грубая статическая проверка синтаксиса).
    assert text.count("{") == text.count("}")
    assert text.count("(") == text.count(")")
    assert text.count('"') % 2 == 0


def test_readme_has_plain_layer_and_expert_layer(tmp_path):
    """README в двух слоях (замечание владельца 03.09): человеческое «что это
    и зачем» + пошаговая проверка для трёх ОС, и только потом экспертная часть
    под оговоркой. Двуязычие построчно сохраняется."""
    contract, milestone, _customer, contractor, store = make_deal("p9")
    upload(contract, milestone, contractor, store)
    relay_all()
    export = _export(contract, contractor, store=store)
    package_zip, _files_zip, _record, _sums, _n = services.build_artifacts(
        export, evidence_store=store
    )
    _unzip(package_zip, tmp_path)
    readme = (tmp_path / "README.txt").read_text(encoding="utf-8")

    # слой 1 — «что это и зачем»
    assert "ЧАСТЬ 1. ЧТО ЭТО И ЗАЧЕМ" in readme
    assert "PART 1. WHAT THIS IS AND WHY" in readme
    assert "отпечаток" in readme
    assert "ПРОВЕРЯТЬ НИЧЕГО НЕ ОБЯЗАТЕЛЬНО" in readme
    assert "YOU DO NOT HAVE TO VERIFY ANYTHING" in readme
    for name in ("manifest.json", "SHA256SUMS", "verify.ps1", "verify.py", "index.html"):
        assert name in readme
    # слой 2 — три пути по шагам и что видно на экране
    assert "ЧАСТЬ 2. КАК ПРОВЕРИТЬ" in readme
    assert "WINDOWS" in readme and "MACOS" in readme and "LINUX" in readme
    assert "powershell -ExecutionPolicy Bypass -File .\\verify.ps1" in readme
    assert "Get-FileHash" in readme
    assert "shasum -a 256 -c SHA256SUMS" in readme
    assert "sha256sum -c SHA256SUMS" in readme
    assert "sha256sum -c --ignore-missing SHA256SUMS" in readme
    assert "manifest.json: OK" in readme
    assert "«FAILED»" in readme
    # слой 3 — экспертный, с оговоркой перед ним
    assert "ЧАСТЬ 3. ДАЛЬШЕ — ДЛЯ ЭКСПЕРТА ИЛИ СУДА" in readme
    assert "обычному участнику сделки не нужно" in readme
    assert readme.index("ЧАСТЬ 2. КАК ПРОВЕРИТЬ") < readme.index("ЧАСТЬ 3.")
    assert "Цепочка Audit Vault" in readme and "RFC 3161" in readme


def test_readme_is_deterministic_between_two_builds():
    """README и весь package.zip не «плавают» между сборками одного экспорта —
    package_sha256 в API остаётся тем же."""
    contract, milestone, _customer, contractor, store = make_deal("p10")
    upload(contract, milestone, contractor, store)
    relay_all()
    checkpoint()
    export = _export(contract, contractor, store=store)

    first_zip, _f1, record_a, _s1, _n1 = services.build_artifacts(export, evidence_store=store)
    second_zip, _f2, record_b, _s2, _n2 = services.build_artifacts(export, evidence_store=store)

    readme_a = package.readme_text(record_a, openssl_commands=[])
    readme_b = package.readme_text(record_b, openssl_commands=[])
    assert readme_a == readme_b
    assert package.sha256_hex(first_zip) == package.sha256_hex(second_zip)


def _minimal_record(additional_terms: list[str]) -> dict:
    """Скелет записи для `index_html` — «оглавление для человека» рендерится
    из записи, а не из БД (ADR-167: секция дополнительных условий)."""
    return {
        "format": "full",
        "export": {"id": "exp-1", "snapshot_at": "2026-09-05T00:00:00+00:00", "is_snapshot": False},
        "contract": {
            "id": "c-1",
            "number": "ПР-1",
            "title": "Ремонт крана",
            "parties": {},
            "versions": [],
            "signatures": [],
            "additional_terms": additional_terms,
        },
        "amendments": [],
        "evidence": [],
        "audit_checkpoints": [],
        "sections": {
            "milestones": {"count": 1},
            "events": {"count": 1},
            "evidence": {"count": 0, "size_bytes": 0},
            "payments": {"count": 0},
            "dispute": {"count": 0},
        },
    }


def test_index_html_renders_additional_terms_section():
    html = package.index_html(_minimal_record(["Ключи под расписку", "Уборка после работ"]))
    assert "<h2>Дополнительные условия</h2>" in html
    assert "<li>Ключи под расписку</li>" in html
    assert "<li>Уборка после работ</li>" in html


def test_index_html_escapes_additional_terms():
    html = package.index_html(_minimal_record(["<script>alert(1)</script>"]))
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_index_html_without_additional_terms_has_no_section():
    assert "Дополнительные условия" not in package.index_html(_minimal_record([]))
