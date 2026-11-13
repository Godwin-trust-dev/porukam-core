"""Сборка доказательного пакета (ADR-139) — чистые функции над уже
собранными данными: ни БД, ни настроек. Вход — запись сделки (dict из
`selectors.collect_record`), список файлов, файлы чекпойнтов; выход —
байты `package.zip` / `files.zip`.

Детерминизм (тест «одинаковые байты при повторе»): единственное время в
пакете — `snapshot_at` экспорта; порядок файлов в zip — лексикографический;
`date_time` каждого ZipInfo — `snapshot_at`; JSON — `sort_keys`. Никаких
`datetime.now()` внутри.

Состав `package.zip` (килобайты, хранится бессрочно):
    manifest.json          запись сделки + доказательства + цепочный путь
    SHA256SUMS             формат `sha256sum -c` (все файлы пакета + files.zip)
    README.txt             что это и как проверить (два слоя: человеку / эксперту)
    index.html             оглавление (печать в PDF — браузером)
    verify.py              офлайн-проверка (только стандартная библиотека)
    verify.ps1             то же для Windows: отпечатки через Get-FileHash
    checkpoint-<id>.json   заверенный якорь Vault + NN-<host>.tsr/.tsq/.chain.pem
Состав `files.zip` (мегабайты, по сроку хранения):
    files/<evidence_id>_<file_name>     оригинал (открытые байты, как у контрагента)
    thumbnails/<evidence_id>.jpg        миниатюра

PDF-оглавления НЕТ намеренно: в `uv.lock` нет WeasyPrint/reportlab/fpdf, а
«минимальный PDF своими руками» с базовыми шрифтами не умеет кириллицу —
вместо обмана шрифтами отдаём `index.html` (UTF-8, печатается в PDF любым
браузером). PDF — следующий шаг (ADR-139 «Что позже»)."""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime
from html import escape
from typing import Any

MANIFEST_FORMAT = "porukam.archive_manifest/1"
PACKAGE_ROOT_FILES = (
    "manifest.json",
    "SHA256SUMS",
    "README.txt",
    "index.html",
    "verify.py",
    "verify.ps1",
)

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True, slots=True)
class PackageFile:
    path: str
    content: bytes


def safe_file_name(name: str, *, fallback: str = "file") -> str:
    """Имя файла внутри zip: только ASCII-безопасные символы (пути в
    SHA256SUMS обязаны совпадать байт-в-байт в любой ОС/локали)."""
    cleaned = _SAFE_NAME.sub("_", name).strip("._")
    return cleaned or fallback


def evidence_file_path(evidence_id: str, file_name: str) -> str:
    return f"files/{evidence_id}_{safe_file_name(file_name)}"


def thumbnail_path(evidence_id: str) -> str:
    return f"thumbnails/{evidence_id}.jpg"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256sums_text(entries: list[tuple[str, str]]) -> str:
    """`<hex>  <path>` — формат GNU coreutils `sha256sum -c` (два пробела:
    текстовый режим). Пути — относительно корня распакованных zip."""
    return "".join(f"{digest}  {path}\n" for path, digest in sorted(entries))


def _zip_datetime(snapshot_at: datetime) -> tuple[int, int, int, int, int, int]:
    # ZIP хранит локальное время без зоны и не раньше 1980 — берём UTC-поля
    # snapshot_at как есть (детерминированно, одинаково на любой машине).
    year = max(snapshot_at.year, 1980)
    return (year, snapshot_at.month, snapshot_at.day, snapshot_at.hour, snapshot_at.minute, 0)


def build_zip(files: list[PackageFile], *, snapshot_at: datetime) -> bytes:
    """Детерминированный zip: фиксированные метаданные записей, сортировка
    по пути, deflate. Дубликат пути — ошибка сборки, не тихая перезапись."""
    buffer = io.BytesIO()
    seen: set[str] = set()
    stamp = _zip_datetime(snapshot_at)
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(files, key=lambda f: f.path):
            if item.path in seen:
                raise ValueError(f"дубликат пути в архиве: {item.path}")
            seen.add(item.path)
            info = zipfile.ZipInfo(item.path, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3
            archive.writestr(info, item.content)
    return buffer.getvalue()


def manifest_json(record: dict[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, ensure_ascii=False, indent=1).encode("utf-8")


def _fmt(value: Any) -> str:  # noqa: ANN401
    return "—" if value in (None, "") else escape(str(value))


def readme_text(record: dict[str, Any], *, openssl_commands: list[str]) -> str:
    """README пакета в двух слоях (замечание владельца 03.09): часть 1 —
    «что это и зачем» человеческим языком, часть 2 — проверка по шагам для
    Windows/macOS/Linux, часть 3 — экспертная (хеши, цепочка, RFC 3161) под
    явной оговоркой «обычному участнику не нужно». Двуязычие построчно:
    русская строка, следом английская. Никакого времени, кроме snapshot_at —
    текст детерминирован."""
    contract = record["contract"]
    export = record["export"]
    rule = "-" * 72
    lines = [
        "ПО РУКАМ — ДОКАЗАТЕЛЬНЫЙ ПАКЕТ СДЕЛКИ / PORUKAM — DEAL EVIDENCE PACKAGE",
        "=" * 72,
        f"Договор / Contract: {contract['number']} ({contract['id']})",
        f"Снимок / Snapshot at: {export['snapshot_at']}"
        + (" (сделка ещё не окончена / deal not finished yet)" if export["is_snapshot"] else ""),
        f"Экспорт / Export id: {export['id']}",
        "",
        rule,
        "ЧАСТЬ 1. ЧТО ЭТО И ЗАЧЕМ",
        "PART 1. WHAT THIS IS AND WHY",
        rule,
        "",
        "Это снимок вашей сделки: договор и все его версии, этапы с чек-листами,",
        "хроника событий, платежи, разногласия и файлы доказательств — такими,",
        "какими они были на момент снимка, указанный выше.",
        "This is a snapshot of your deal: the contract with all its versions,",
        "milestones with checklists, the event timeline, payments, disagreements",
        "and evidence files — exactly as they were at the snapshot moment above.",
        "",
        "К каждому файлу приложен его «отпечаток» (по-другому — хеш): строка из",
        "64 знаков, которую считает компьютер по содержимому файла. Изменится в",
        "файле хоть один байт — отпечаток станет другим. Совпал отпечаток —",
        "значит, файл ровно тот же самый.",
        "Every file comes with a «fingerprint» (a hash): a 64-character string a",
        "computer derives from the file content. Change a single byte and the",
        "fingerprint changes. If the fingerprint matches, the file is exactly the",
        "same file.",
        "",
        "ПРОВЕРЯТЬ НИЧЕГО НЕ ОБЯЗАТЕЛЬНО. Такой же пакет получила вторая сторона",
        "сделки, а отпечатки платформа хранит бессрочно. Проверка нужна только",
        "тогда, когда надо доказать, что файл не подменили, — например, если об",
        "этом зашёл спор.",
        "YOU DO NOT HAVE TO VERIFY ANYTHING. The other party got the same package,",
        "and the platform keeps the fingerprints forever. You verify only when you",
        "need to prove that a file was not swapped — in a dispute, for instance.",
        "",
        "Что лежит в пакете / What is in the package:",
        "  README.txt    этот файл / this file",
        "  index.html    оглавление для человека: откройте двойным щелчком в",
        "                браузере, «Печать» → «Сохранить в PDF»",
        "                human-readable contents; open in a browser, Print →",
        "                Save as PDF",
        "  manifest.json та же запись сделки целиком — для программ и экспертизы",
        "                the same deal record in full — for software and experts",
        "  SHA256SUMS    список отпечатков всех файлов (по строке на файл)",
        "                the list of fingerprints, one line per file",
        "  verify.ps1    проверка отпечатков в Windows одной командой",
        "                one-command fingerprint check on Windows",
        "  verify.py     то же плюс проверка цепочки Audit Vault; нужен Python 3",
        "                the same plus the Audit Vault chain check; needs Python 3",
        "  checkpoint-*  заверенная метка времени и сертификаты (для эксперта)",
        "                the trusted timestamp and certificates (for an expert)",
        "  files.zip     ОТДЕЛЬНЫЙ архив: files/ — сами файлы доказательств,",
        "                thumbnails/ — их уменьшенные копии",
        "                a SEPARATE archive: files/ — the evidence files,",
        "                thumbnails/ — their previews",
        "",
        rule,
        "ЧАСТЬ 2. КАК ПРОВЕРИТЬ, ЧТО ФАЙЛЫ НЕ МЕНЯЛИСЬ",
        "PART 2. HOW TO CHECK THAT THE FILES WERE NOT CHANGED",
        rule,
        "",
        "Шаг 0, общий для всех систем: распакуйте ОБА архива — package.zip и",
        "files.zip — в ОДНУ И ТУ ЖЕ папку. Если files.zip у вас нет (не",
        "скачивали или срок хранения файлов истёк), распакуйте один package.zip:",
        "проверка пройдёт по файлам пакета, а остальные будут отмечены как",
        "пропущенные — это не ошибка.",
        "Step 0, same on every system: unpack BOTH archives — package.zip and",
        "files.zip — into ONE AND THE SAME folder. If you have no files.zip (never",
        "downloaded, or the retention period is over), unpack package.zip alone:",
        "the check covers the package files and marks the rest as missing — that",
        "is not an error.",
        "",
        "WINDOWS",
        " 1. Найдите package.zip в Проводнике, щёлкните правой кнопкой, выберите",
        "    «Извлечь всё…» и запомните папку, которую Windows предложит.",
        "    Right-click package.zip in File Explorer, choose «Extract All…» and",
        "    remember the folder Windows offers.",
        " 2. То же самое сделайте с files.zip, указав ТУ ЖЕ САМУЮ папку.",
        "    Do the same with files.zip, choosing THE SAME folder.",
        " 3. Откройте эту папку, щёлкните правой кнопкой по пустому месту и",
        "    выберите «Открыть в терминале» (в Windows 10 — Shift + правая",
        "    кнопка, «Открыть окно PowerShell здесь»).",
        "    Open that folder, right-click empty space and choose «Open in",
        "    Terminal» (Windows 10: Shift + right-click, «Open PowerShell window",
        "    here»).",
        " 4. Наберите команду и нажмите Enter:",
        "       powershell -ExecutionPolicy Bypass -File .\\verify.ps1",
        "    Она читает SHA256SUMS, заново считает отпечаток каждого файла и",
        "    сравнивает со списком. «-ExecutionPolicy Bypass» нужен потому, что",
        "    Windows по умолчанию не запускает скачанные скрипты.",
        "    Type the command and press Enter. It reads SHA256SUMS, recomputes",
        "    every fingerprint and compares. «-ExecutionPolicy Bypass» is needed",
        "    because Windows blocks downloaded scripts by default.",
        " 5. Если скрипт запустить не удалось, проверьте файл вручную:",
        "       Get-FileHash .\\manifest.json -Algorithm SHA256",
        "    Команда печатает отпечаток одного файла; сравните его со строкой",
        "    этого файла в SHA256SUMS (откройте её Блокнотом; регистр букв",
        "    значения не имеет).",
        "    If the script will not run, check a file by hand: the command prints",
        "    the fingerprint of one file; compare it with that file's line in",
        "    SHA256SUMS (open it in Notepad; letter case does not matter).",
        "",
        "MACOS",
        " 1. Дважды щёлкните package.zip и files.zip — рядом появятся папки;",
        "    сложите содержимое обеих в одну папку.",
        "    Double-click package.zip and files.zip — folders appear next to them;",
        "    put the contents of both into one folder.",
        " 2. Откройте Терминал (Программы → Утилиты → Терминал), наберите «cd »",
        "    с пробелом в конце, перетащите папку мышью в окно Терминала и",
        "    нажмите Enter — так вы перейдёте в эту папку.",
        "    Open Terminal (Applications → Utilities → Terminal), type «cd » with",
        "    a trailing space, drag the folder into the Terminal window and press",
        "    Enter — that moves you into the folder.",
        " 3. Выполните команду — она читает SHA256SUMS и проверяет каждый файл:",
        "       shasum -a 256 -c SHA256SUMS",
        "    Если files.zip вы не распаковывали, добавьте «--ignore-missing»:",
        "       shasum -a 256 -c --ignore-missing SHA256SUMS",
        "    Run the command — it reads SHA256SUMS and checks every listed file;",
        "    without files.zip add «--ignore-missing».",
        "",
        "LINUX",
        " 1. Распакуйте оба архива в один каталог и проверьте одной строкой:",
        "       unzip package.zip && unzip files.zip && sha256sum -c SHA256SUMS",
        "    unzip распаковывает архивы, sha256sum -c сверяет каждый файл со",
        "    списком отпечатков.",
        "    Unpack both archives into one directory and check in one line: unzip",
        "    extracts, «sha256sum -c» verifies every file against the list.",
        " 2. Если files.zip нет:",
        "       sha256sum -c --ignore-missing SHA256SUMS",
        "    Without files.zip use «--ignore-missing».",
        "",
        "ЧТО ДОЛЖНО ПОЯВИТЬСЯ НА ЭКРАНЕ / WHAT YOU SHOULD SEE",
        "    manifest.json: OK",
        "    README.txt: OK",
        "    index.html: OK",
        "    verify.py: OK",
        "    files/<...>: OK",
        "«OK» в конце каждой строки означает, что файл не изменился ни на байт.",
        "Все строки «OK» — проверка пройдена, больше ничего делать не нужно.",
        "«OK» at the end of every line means the file is byte-for-byte intact.",
        "All lines «OK» — the check passed, nothing else to do.",
        "",
        "«FAILED» (в verify.ps1 — тоже «FAILED») означает обратное: файл с этим",
        "именем есть, но его содержимое отличается от снимка. Не удаляйте и не",
        "исправляйте файл — сохраните вывод команды и обратитесь в поддержку",
        "платформы или к своему юристу: расхождение само по себе является",
        "фактом, который надо зафиксировать.",
        "«FAILED» means the opposite: a file with that name exists, but its",
        "content differs from the snapshot. Do not delete or fix the file — save",
        "the command output and contact platform support or your lawyer: the",
        "mismatch itself is a fact worth recording.",
        "",
        "«ПРОПУЩЕН» / «MISSING» / «No such file» — файла в папке просто нет.",
        "Обычная причина: files.zip не распакован в ту же папку или уже удалён",
        "по сроку хранения. Это не расхождение.",
        "«ПРОПУЩЕН» / «MISSING» / «No such file» — the file is not in the folder.",
        "Usually files.zip was not unpacked into the same folder or is already",
        "deleted per the retention period. This is not a mismatch.",
        "",
        rule,
        "ЧАСТЬ 3. ДАЛЬШЕ — ДЛЯ ЭКСПЕРТА ИЛИ СУДА",
        "PART 3. THE REST IS FOR AN EXPERT OR A COURT",
        rule,
        "",
        "Всё, что ниже, обычному участнику сделки не нужно: часть 2 уже показала,",
        "что файлы не менялись. Дальше — для специалиста, который проверяет пакет",
        "без участия платформы (ADR-036).",
        "Everything below is not needed by an ordinary party: part 2 already",
        "showed the files are intact. What follows is for a specialist verifying",
        "the package without the platform (ADR-036).",
        "",
        "A. Хеши доказательств / Evidence hashes:",
        "   manifest.json -> evidence[].sha256 — sha256 очищенных байт файла,",
        "   тех же, что получил контрагент; sha256sum files/<...> обязан совпасть.",
        "",
        "B. Цепочка Audit Vault / Hash chain:",
        "   python3 verify.py — пересчитывает записи этой сделки",
        "   (this_hash = sha256(prev_hash || canonical)) и проходит по цепочному",
        "   пути до корня чекпойнта (manifest.json -> audit_chains). Чужие звенья",
        "   даны только хешем (их содержимое принадлежит другим сделкам);",
        "   полные листья хранятся в WORM-объекте чекпойнта и выдаются по",
        "   запросу суда/эксперта.",
        "",
        "C. Доверенная метка времени RFC 3161 / Trusted timestamp:",
    ]
    if openssl_commands:
        lines += ["   " + command for command in openssl_commands]
        lines += [
            "   genTime в ответе TSA = момент, не позже которого существовал корень",
            "   чекпойнта, а значит и каждая запись пути к нему.",
        ]
    else:
        lines += [
            "   в этом пакете нет заверенного чекпойнта (запись ещё не попала в",
            "   суточный якорь либо метка не была получена) — см. manifest.json",
            "   -> audit_checkpoints[].tsa_status.",
        ]
    lines += [
        "",
        "Хеши, .tsr и цепочки сертификатов платформа хранит бессрочно; файлы —",
        "по сроку хранения (manifest.json -> retention). Скачанная копия сохраняет",
        "доказательную силу: её подлинность проверяется по хешу.",
        "The platform keeps hashes, .tsr files and certificate chains forever;",
        "the files themselves — for the retention period (manifest.json ->",
        "retention). A downloaded copy keeps its evidentiary value: its",
        "authenticity is proven by the hash.",
        "",
    ]
    return "\n".join(lines)


def index_html(record: dict[str, Any]) -> str:
    """Оглавление пакета — самодостаточный HTML (печать в PDF браузером)."""
    contract = record["contract"]
    export = record["export"]
    parties = contract.get("parties", {})
    rows_parties = "".join(
        f"<tr><td>{_fmt(role)}</td><td>{_fmt(p.get('display_name'))}</td>"
        f"<td>{_fmt(p.get('acting_as'))}</td><td><code>{_fmt(p.get('profile_id'))}</code></td></tr>"
        for role, p in sorted(parties.items())
    )
    rows_evidence = "".join(
        f"<tr><td><code>{_fmt(e['path'])}</code></td><td>{_fmt(e['file_size'])}</td>"
        f"<td>{_fmt(e['trusted_timestamp_at'])}</td><td>{_fmt(e['lateness'])}</td>"
        f"<td>{'да' if e['strong_protection'] else 'нет'}</td>"
        f"<td><code>{_fmt(e['sha256'])}</code></td></tr>"
        for e in record["evidence"]
    )
    sections = [
        (
            "Договор",
            f"версий: {len(contract.get('versions', []))}, подписей: "
            f"{len(contract.get('signatures', []))}, допников: {len(record.get('amendments', []))}",
        ),
        ("Этапы", f"{record['sections']['milestones']['count']} этап(ов)"),
        ("События", f"{record['sections']['events']['count']} записей хроники"),
        (
            "Доказательства",
            f"{record['sections']['evidence']['count']} файл(ов), "
            f"{record['sections']['evidence']['size_bytes']} байт",
        ),
        ("Платежи", f"{record['sections']['payments']['count']}"),
        ("Разногласия", f"{record['sections']['dispute']['count']}"),
    ]
    rows_sections = "".join(
        f"<tr><td>{escape(k)}</td><td>{escape(v)}</td></tr>" for k, v in sections
    )
    # ADR-167/ADR-123: дополнительные условия — часть текста договора
    # (ручной ввод в мастере + принятые правки «Другое»). В manifest.json они
    # были с самого начала, а человек читает index.html — без секции пункты
    # в «пакете для человека» просто не видны. Пустой список секции не даёт.
    additional_terms = contract.get("additional_terms") or []
    terms_html = (
        (
            "<h2>Дополнительные условия</h2><ol>"
            + "".join(f"<li>{escape(str(t))}</li>" for t in additional_terms)
            + "</ol>"
        )
        if additional_terms
        else ""
    )
    checkpoints = (
        "".join(
            f"<li>checkpoint #{_fmt(c['checkpoint_id'])}: "
            f"seq [{_fmt(c['seq_from'])}, {_fmt(c['seq_to'])}], "
            f"root <code>{_fmt(c['root'])}</code>, TSA: {_fmt(c['tsa_status'])}</li>"
            for c in record["audit_checkpoints"]
        )
        or "<li>заверенных чекпойнтов в пакете нет</li>"
    )
    return (
        '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
        f"<title>Доказательный пакет — договор {_fmt(contract['number'])}</title>"
        "<style>body{font-family:sans-serif;max-width:960px;margin:2em auto;padding:0 1em;"
        "color:#16283C}table{border-collapse:collapse;width:100%;font-size:14px}"
        "td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}"
        "code{font-size:12px;word-break:break-all}</style></head><body>"
        f"<h1>Доказательный пакет сделки</h1>"
        f"<p>Договор <b>{_fmt(contract['number'])}</b> «{_fmt(contract.get('title'))}» "
        f"· снимок на {_fmt(export['snapshot_at'])}"
        + (" · <b>сделка ещё не окончена</b>" if export["is_snapshot"] else "")
        + f"<br>Экспорт <code>{_fmt(export['id'])}</code> · формат {_fmt(record['format'])}</p>"
        "<h2>Стороны</h2><table><tr><th>Роль</th><th>Имя</th><th>Выступает как</th>"
        "<th>Профиль</th></tr>"
        f"{rows_parties}</table>"
        "<h2>Состав</h2><table>"
        + rows_sections
        + "</table>"
        + terms_html
        + "<h2>Доказательства</h2><table><tr><th>Файл</th><th>Байт</th><th>Получено</th>"
        f"<th>Окно</th><th>Усиленная защита</th><th>sha256</th></tr>{rows_evidence}</table>"
        f"<h2>Audit Vault</h2><ul>{checkpoints}</ul>"
        "<h2>Как проверить</h2><p>Подробно и по шагам — в <code>README.txt</code> "
        "(часть 2: Windows, macOS, Linux). Коротко: Windows — "
        "<code>powershell -ExecutionPolicy Bypass -File .\\verify.ps1</code>, macOS — "
        "<code>shasum -a 256 -c SHA256SUMS</code>, Linux — "
        "<code>sha256sum -c SHA256SUMS</code>. Для эксперта: <code>python3 verify.py</code>, "
        "<code>openssl ts -verify …</code>. Пакет проверяется без участия "
        "платформы.</p></body></html>"
    )


# BOM в начале — Windows PowerShell 5.1 без него читает .ps1 в кодировке
# системы и портит кириллицу.
VERIFY_PS1 = (
    "﻿"
    + r"""#!/usr/bin/env pwsh
# Проверка доказательного пакета «По рукам» в Windows (PowerShell 5.1+).
# Verifies the Porukam evidence package on Windows (PowerShell 5.1+).
#
# Запуск / How to run:
#   powershell -ExecutionPolicy Bypass -File .\verify.ps1
#
# Аналог `sha256sum -c SHA256SUMS`: читает SHA256SUMS, заново считает
# отпечаток каждого файла (Get-FileHash) и печатает «OK» либо «FAILED».
# Отсутствующие файлы (files.zip не распакован) помечаются «ПРОПУЩЕН /
# MISSING» и ошибкой не считаются. Код возврата: 0 — расхождений нет,
# 1 — есть FAILED, 2 — рядом со скриптом нет SHA256SUMS.

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$sumsPath = Join-Path $root "SHA256SUMS"

if (-not (Test-Path -LiteralPath $sumsPath)) {
    Write-Host "SHA256SUMS не найден рядом со скриптом — распакуйте package.zip целиком."
    Write-Host "SHA256SUMS not found next to the script - unpack the whole package.zip."
    exit 2
}

$sep = [string][System.IO.Path]::DirectorySeparatorChar
$ok = 0
$failed = 0
$missing = 0

foreach ($line in [System.IO.File]::ReadAllLines($sumsPath, [System.Text.Encoding]::UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $cut = $line.IndexOf("  ")
    if ($cut -lt 1) { continue }
    $digest = $line.Substring(0, $cut).Trim().ToLowerInvariant()
    $rel = $line.Substring($cut + 2).Trim()
    if ($digest.Length -ne 64 -or $rel.Length -eq 0) { continue }
    $native = $rel.Replace("/", $sep)
    $full = Join-Path $root $native
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $missing = $missing + 1
        Write-Host ("{0}: ПРОПУЩЕН / MISSING" -f $rel)
        continue
    }
    $actual = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -eq $digest) {
        $ok = $ok + 1
        Write-Host ("{0}: OK" -f $rel)
    } else {
        $failed = $failed + 1
        Write-Host ("{0}: FAILED" -f $rel)
    }
}

Write-Host ""
Write-Host ("Итог / Summary: OK={0} FAILED={1} ПРОПУЩЕНО-MISSING={2}" -f $ok, $failed, $missing)

if ($failed -gt 0) {
    Write-Host "Есть расхождения: содержимое файла отличается от снимка сделки."
    Write-Host "Сохраните этот вывод и обратитесь в поддержку платформы или к юристу."
    Write-Host "Mismatch found: the file content differs from the deal snapshot."
    Write-Host "Save this output and contact platform support or your lawyer."
    exit 1
}

if ($missing -gt 0) {
    Write-Host "Пропущенные файлы — это не ошибка: files.zip не распакован в эту же"
    Write-Host "папку либо удалён по сроку хранения. Все найденные файлы целы."
    Write-Host "Missing files are not an error: files.zip was not unpacked into this"
    Write-Host "folder or is deleted per the retention period. Every file found is intact."
}

Write-Host "Проверка пройдена: файлы не менялись. / Check passed: files are intact."
exit 0
"""
)

VERIFY_PY = r'''#!/usr/bin/env python3
"""Офлайн-проверка доказательного пакета «По рукам» (только стандартная
библиотека). Запуск из каталога, куда распакованы package.zip (и, если есть,
files.zip): python3 verify.py"""
import hashlib, json, os, sys

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def check_sums():
    ok = bad = missing = 0
    for line in open("SHA256SUMS", encoding="utf-8"):
        line = line.rstrip("\n")
        if not line:
            continue
        digest, path = line.split("  ", 1)
        if not os.path.exists(path):
            missing += 1
            continue
        if sha256(path) == digest:
            ok += 1
        else:
            bad += 1
            print("MISMATCH", path)
    print(f"SHA256SUMS: ok={ok} mismatch={bad} missing={missing}")
    return bad == 0

def check_chains(manifest):
    all_ok = True
    for ref, chain in sorted(manifest.get("audit_chains", {}).items()):
        prev = None
        disclosed = hidden = 0
        for link in chain["links"]:
            if prev is not None and link["prev_hash"] != prev:
                print(f"chain {ref}: seq {link['seq']} prev_hash breaks the chain"); all_ok = False
            if link.get("canonical") is not None:
                material = (link["prev_hash"] + link["canonical"]).encode("ascii")
                expected = hashlib.sha256(material).hexdigest()
                doc = json.loads(link["canonical"])
                if (expected != link["this_hash"] or doc.get("prev_hash") != link["prev_hash"]
                        or doc.get("seq") != link["seq"]):
                    print(f"chain {ref}: seq {link['seq']} canonical != this_hash")
                    all_ok = False
                disclosed += 1
            else:
                hidden += 1
            prev = link["this_hash"]
        root_ok = prev == chain["root"]
        if not root_ok:
            print(f"chain {ref}: last link {prev} != checkpoint root {chain['root']}")
            all_ok = False
        print(f"chain {ref}: links={len(chain['links'])} disclosed={disclosed} hash-only={hidden} "
              f"root={'OK' if root_ok else 'FAIL'} tsa_status={chain.get('tsa_status')}")
    return all_ok

def main():
    manifest = json.load(open("manifest.json", encoding="utf-8"))
    sums_ok = check_sums()
    chains_ok = check_chains(manifest)
    for cp in manifest.get("audit_checkpoints", []):
        for cmd in cp.get("openssl", []):
            print("timestamp:", cmd)
    print("RESULT:", "OK" if (sums_ok and chains_ok) else "FAIL")
    sys.exit(0 if (sums_ok and chains_ok) else 1)

if __name__ == "__main__":
    main()
'''


def build_package(
    record: dict[str, Any],
    *,
    file_entries: list[tuple[str, str]],
    checkpoint_files: list[PackageFile],
    openssl_commands: list[str],
    snapshot_at: datetime,
) -> tuple[bytes, str]:
    """`package.zip` + текст SHA256SUMS. `file_entries` — (путь, sha256) файлов
    из files.zip (они тоже входят в SHA256SUMS: пакет доказывает файлы).
    manifest.json пишется до SHA256SUMS и входит в неё — SHA256SUMS сама
    себя не содержит."""
    manifest = manifest_json(record)
    readme = readme_text(record, openssl_commands=openssl_commands).encode("utf-8")
    html = index_html(record).encode("utf-8")
    verify = VERIFY_PY.encode("utf-8")
    verify_ps1 = VERIFY_PS1.encode("utf-8")
    package_files = [
        PackageFile("manifest.json", manifest),
        PackageFile("README.txt", readme),
        PackageFile("index.html", html),
        PackageFile("verify.py", verify),
        PackageFile("verify.ps1", verify_ps1),
        *checkpoint_files,
    ]
    entries = list(file_entries) + [(f.path, sha256_hex(f.content)) for f in package_files]
    sums = sha256sums_text(entries)
    package_files.append(PackageFile("SHA256SUMS", sums.encode("utf-8")))
    return build_zip(package_files, snapshot_at=snapshot_at), sums
