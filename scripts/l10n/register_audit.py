#!/usr/bin/env python3
"""Детектор регистра вежливости (T/V) в двух контурах локализации.

Контуры:
  * web  — `packages/i18n/src/locales/<locale>/*.json` (namespace-файлы экрана);
  * pack — `l10n/packs/<locale>.json` (письма, пуши, ошибки, каталог, ui, legal).

Для каждой локали с грамматическим различием «ты/вы» задан целевой регистр
(см. docs/tasks/l10n-register-2026-09-05.md) и два набора маркеров: T
(неформальный) и V (формальный/вежливый). Детектор — ПОДСКАЗКА, а не автоправка:
часть маркеров омонимична (исп. `su` — и «ваш», и «его/её» о контрагенте;
нем. `Sie` — и «Вы», и «они»; ивр. `את` — и «ты (ж.р.)», и винительная частица),
поэтому каждое попадание проверяется человеком/агентом по смыслу.

Использование:
    python3 scripts/l10n/register_audit.py                 # все локали, сводка
    python3 scripts/l10n/register_audit.py es fr           # только эти локали
    python3 scripts/l10n/register_audit.py --list es       # строки-нарушители
    python3 scripts/l10n/register_audit.py --json out.json # машинный вывод
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections.abc import Iterator

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB_DIR = os.path.join(ROOT, "packages", "i18n", "src", "locales")
PACK_DIR = os.path.join(ROOT, "l10n", "packs")

# ── Правила по локалям ────────────────────────────────────────────────────────
# target: "T" — неформальное обращение, "V" — вежливое/формальное.
# markers_T / markers_V — регулярки маркеров соответствующего регистра.
# ambiguous — регулярки, которые часто дают ложные срабатывания (для пометки).
# none — язык без грамматического T/V-различия: только фиксируем в таблице.

RULES: dict[str, dict] = {
    # ── Романские ────────────────────────────────────────────────────────────
    "es": {
        "ignorecase": True,  # заглавная буква не различает регистры обращения
        "target": "T",  # tú — решение аудита волны A (п.14)
        "markers_V": [
            r"\busted(?:es)?\b",
            # формальный императив / presente de subjuntivo 3sg в роли обращения
            (
                r"\b(?:pulse|haga|elija|introduzca|seleccione|revise|confirme|añada|"
                r"envíe|acceda|complete|escriba|indique|compruebe|guarde|cree|firme|"
                r"vaya|espere|intente|contacte|verifique|marque|abra|cierre|adjunte|"
                r"describa|especifique|rellene|actualice|active|desactive|inicie|"
                r"cancele|acepte|rechace|continúe|vuelva|pruebe|tenga|sepa|recuerde|"
                r"asegúrese|diríjase|póngase|inténtelo|revíselo|hágalo|solicite|"
                r"resuelva|ayude|descargue|comparta|conserve|mantenga|señale|suba)\b"
            ),
            r"\b(?:le|les)\s+(?:informamos|enviamos|avisamos|recordamos)\b",
            # usted-императив с энклитикой: «Ayúdenos», «Resuélvalas», «Complételas».
            # tú-форма ставит другую гласную: «Ayúdanos», «Resuélvelas», «Complétalas»
            (
                r"\b(?:ayúde|resuélva|compléte|solicíte|revíse|inténte|verifíque|"
                r"compruébe|actualíce|elíja|adjúnte|descárgue|compárta)"
                r"(?:nos|los|las|le|lo|la|se|me)\b"
            ),
        ],
        "markers_T": [
            r"\bt[úu]s?\b", r"\bte\b", r"\bti\b", r"\bcontigo\b",
            (
                r"\b(?:pulsa|haz|elige|introduce|selecciona|revisa|confirma|añade|"
                r"envía|accede|completa|escribe|indica|comprueba|guarda|crea|firma|"
                r"ve|espera|intenta|contacta|verifica|marca|abre|cierra|adjunta|"
                r"describe|especifica|rellena|actualiza|activa|desactiva|inicia|"
                r"cancela|acepta|rechaza|continúa|vuelve|prueba|ten|recuerda)\b"
            ),
        ],
        # vosotros — региональный (Испания) вариант мн. ч.; для нейтрального
        # испанского при tú-регистре мн. ч. — ustedes.
        "markers_extra": {
            "vosotros (Испания) — заменить на ustedes": [
                r"\bvosotr[oa]s\b", r"\bvuestr[oa]s?\b",
                r"\b\w+áis\b", r"\b\w+éis\b", r"\bvais\b", r"\bsois\b", r"\bhabéis\b",
            ]
        },
        "ambiguous": [r"\bsus?\b", r"\ble\b", r"\bles\b"],
    },
    "pt-BR": {
        "ignorecase": True,  # заглавная буква не различает регистры обращения
        "target": "T",  # você — бразильская норма продукта
        "markers_V": [
            r"\bo\s+senhor\b", r"\ba\s+senhora\b", r"\bos\s+senhores\b",
            r"\bVossa\s+Senhoria\b", r"\bqueira\b", r"\bfavor\s+de\b",
        ],
        "markers_T": [r"\bvocês?\b", r"\bteu\b", r"\btua\b", r"\bte\b"],
        "ambiguous": [r"\bseus?\b", r"\bsuas?\b", r"\blhe\b"],
    },
    "fr": {
        "ignorecase": True,  # заглавная буква не различает регистры обращения
        "target": "V",  # vous — норма для юридического/финансового продукта
        "markers_V": [r"\bvous\b", r"\bvotre\b", r"\bvos\b", r"\bveuillez\b"],
        "markers_T": [
            r"\btu\b",
            r"(?<!en )(?<!le )(?<!du )(?<!ce )(?<!un )(?<!au )\bton\b",
            r"\bta\b", r"\btes\b", r"\btoi\b", r"\btien(?:ne)?s?\b",
        ],
        "ambiguous": [r"\bte\b"],  # te = и «тебя», и элизия перед гласной
    },
    "it": {
        "target": "T",  # tu — преобладает в обоих контурах
        "markers_V": [
            r"\bLei\b",
            # клитика «Le/La» в роли обращения — только перед глаголом, иначе артикль
            (
                r"\bLe\s+(?:è|sono|era|erano|verrà|verranno|abbiamo|ha|hanno|inviamo|"
                r"chiediamo|ricordiamo|comunichiamo|consigliamo|serve|servono|resta|"
                r"restano|spetta|spettano|arriverà|arriveranno)\b"
            ),
            r"\bLa\s+(?:preghiamo|invitiamo|informiamo|ringraziamo|avviseremo|avvisiamo)\b",
            r"\b(?:Suo|Sua|Suoi|Sue|Suoi)\b(?![.!?])",
            r"\bvoglia\s+\w+re\b",
        ],
        "markers_T": [r"\btu\b", r"\btuoi?\b", r"\btua\b", r"\btue\b", r"\bti\b", r"\bte\b"],
        "ambiguous": [r"\bLe\b", r"\bLa\b"],  # артикли/местоимения 3 л.
    },
    "ro": {
        "ignorecase": True,  # заглавная буква не различает регистры обращения
        "target": "T",  # tu — преобладает в web-контуре
        "markers_V": [
            r"\bdumneavoastr[ăa]\b", r"\bDumneavoastr[ăa]\b", r"\bdvs\.?\b",
            r"\bvă\b", r"\bvi\s+se\b", r"\bDvs\b",
            # 2 л. мн. ч. как вежливое обращение БЕЗ «vă» — так дрейфовали
            # errors/notifications/ui. Список поимённый, а не суффикс -ați/-eți/-iți:
            # суффикс совпадает с 2 л. ЕД. ч. у части глаголов («trimiți», «inviți»
            # — это tu). Формы ниже однозначно 2 мн. (tu-форма другая: «trimite»,
            # «alege», «verifică»).
            (
                r"\b(?:reîmprospătați|verificați|solicitați|propuneți|soluționați|"
                r"confirmați|deschideți|examinați|finalizați|descărcați|păstrați|"
                r"indicați|atașați|completați|alegeți|semnați|acceptați|refuzați|"
                r"afișați|creați|trimiteți|ajutați|vizualizați|încercați|obiectați|"
                r"luați|scrieți|găsiți|aveți|ați|puteți|doriți|primiți)"
                r"(?:-[a-zăîâșț]+)?\b"
            ),
        ],
        "markers_T": [
            r"\btu\b", r"\bt[ăa]u\b", r"\bta\b", r"\bt[ăa]i\b", r"\btale\b", r"\bîți\b", r"\bte\b",
        ],
        "ambiguous": [r"\bvi\b", r"\bv[ăa]\b"],
    },
    # ── Германские ───────────────────────────────────────────────────────────
    "de": {
        "target": "V",  # Sie — норма немецкого юридического/финансового продукта
        "markers_V": [r"\bSie\b", r"\bIhr(?:e|en|em|er|es)?\b", r"\bIhnen\b"],
        "markers_T": [
            r"\b[Dd]u\b", r"\b[Dd]ein(?:e|en|em|er|es)?\b", r"\b[Dd]ich\b", r"\b[Dd]ir\b",
            r"\b[Ee]uch\b", r"\b[Ee]uer\b", r"\b[Ee]ure\b",
        ],
        "ambiguous": [r"\bsie\b", r"\bihr(?:e|en|em|er|es)?\b"],  # 3 л. «она/они»
    },
    "nl": {  # локали нет в репозитории — правило на будущее
        "target": "V",
        "markers_V": [r"\bu\b", r"\buw\b"],
        "markers_T": [r"\bje\b", r"\bjij\b", r"\bjouw\b", r"\bjullie\b"],
        "ambiguous": [],
    },
    # ── Славянские ───────────────────────────────────────────────────────────
    "pl": {
        "target": "T",  # Ty — преобладает в обоих контурах
        "markers_V": [
            r"\bPan(?:a|u|em|i|ią|ie)?\b", r"\bPaństw(?:o|a|u|em|ie)\b",
            r"\bprosz[ęe]\s+(?:Pan|o\b)", r"\bWasz(?:a|e|ego|ej)?\b",
            # Безличная вежливая директива вместо Ty-императива: «Prosimy spróbować
            # ponownie», «należy się zalogować». Инфинитив на -ć обязателен, иначе
            # цепляется глагол należeć «принадлежать» («Ten etap należy do innego
            # porozumienia») — это не регистр.
            r"\b[Pp]rosimy\s+(?:\w+\s+){0,2}\w+ć\b",
            r"\b[Nn]ależy\s+(?:się\s+)?(?:\w+\s+){0,2}\w+ć\b",
        ],
        "markers_T": [
            r"\bTy\b", r"\bTw[oó]j\b", r"\bTwoj(?:a|e|ego|ej|emu|ą|ich|im|imi)\b",
            r"\bTwoim?\b", r"\bTwoich\b", r"\bCiebie\b", r"\bCi[ęe]\b", r"\bCi\b", r"\bTob(?:ie|ą)\b",
        ],
        "ambiguous": [r"\bpan(?:a|u|em|i)?\b"],
    },
    "uk": {
        "target": "V",  # Ви — зеркалит ru-контур продукта
        "markers_V": [r"\b[Вв]и\b", r"\b[Вв]ас\b", r"\b[Вв]ам\b", r"\b[Вв]аш\w*\b", r"\b[Вв]ами\b"],
        "markers_T": [
            r"\b[Тт]и\b", r"\b[Тт]ебе\b", r"\b[Тт]ебі\b", r"\b[Тт]обі\b",
            r"\b[Тт]в[ії]й\b", r"\b[Тт]обою\b",
            r"\b[Тт]во(?:я|є|ї|го|єї|єму|їм|їх|їми|їй|ю)\b",
        ],
        "ambiguous": [],
    },
    # ── Тюркские ─────────────────────────────────────────────────────────────
    "tr": {
        "target": "V",  # siz — норма turkish-продукта такого класса
        "markers_V": [r"\bsiz\w*\b", r"\bSiz\w*\b", r"\w+(?:iniz|ınız|ünüz|unuz)\b"],
        # 2 л. ед. ч. в турецком — голая основа глагола, надёжно не детектируется;
        # суффикс -sin/-sın омонимичен 3 л. оптатива («silinsin mi?»), поэтому не берётся
        "markers_T": [
            r"\b[Ss]en\b", r"\b[Ss]enin\b", r"\b[Ss]ana\b", r"\b[Ss]eni\b", r"\b[Ss]ende\b",
        ],
        "ambiguous": [],
    },
    "kk": {
        "target": "V",  # Сіз
        "markers_V": [r"\b[Сс]із\w*\b", r"\w+(?:ңыз|ңіз|ыңыз|іңіз)\b"],
        "markers_T": [r"\b[Сс]ен\b", r"\b[Сс]енің\b", r"\b[Сс]аған\b", r"\b[Сс]ені\b"],
        "ambiguous": [],
    },
    "uz": {
        "target": "V",  # Siz
        "markers_V": [r"\b[Ss]iz\w*\b", r"\w+(?:ngiz|ingiz|yngiz)\b"],
        "markers_T": [r"\b[Ss]en\b", r"\b[Ss]ening\b", r"\b[Ss]enga\b", r"\b[Ss]eni\b"],
        "ambiguous": [],
    },
    "az": {
        "target": "V",  # Siz
        "markers_V": [r"\b[Ss]iz\w*\b", r"\w+(?:iniz|ınız|ünüz|unuz)\b"],
        "markers_T": [r"\b[Ss]ən\b", r"\b[Ss]ənin\b", r"\b[Ss]ənə\b", r"\b[Ss]əni\b"],
        "ambiguous": [],
    },
    # ── Кавказские / индоиранские / семитские ────────────────────────────────
    "hy": {
        "target": "V",  # Դուք / Ձեր
        "markers_V": [r"\b[Դդ]ուք\b", r"\b[Ձձ]եր\b", r"\b[Ձձ]եզ\b", r"\b[Ձձ]եզնից\b"],
        "markers_T": [r"\b[Դդ]ու\b", r"\b[Քք]ո\b", r"\b[Քք]եզ\b", r"\b[Քք]եզնից\b"],
        "ambiguous": [],
    },
    "ka": {
        "target": "V",  # თქვენ
        "markers_V": [r"\bთქვენ\w*\b", r"\bთქვენი\b"],
        "markers_T": [r"\bშენ\b", r"\bშენი\b", r"\bშენს\b", r"\bშენთვის\b"],
        "ambiguous": [],
    },
    "fa": {
        "target": "V",  # شما
        "markers_V": [r"\bشما\b", r"\bشماست\b"],
        "markers_T": [r"\bتو\b", r"\bتوی?\s", r"\bات\b"],
        "ambiguous": [r"\bخود\b"],
    },
    "ur": {
        "target": "V",  # آپ
        "markers_V": [r"\bآپ\b", r"\bآپ\s?کا\b", r"\bآپ\s?کی\b"],
        "markers_T": [r"\bتم\b", r"\bتمہار\w*\b", r"\bتیر[اای]\b"],
        "ambiguous": [],
    },
    "hi": {
        "target": "V",  # आप — норма аудита волны A
        "markers_V": [r"\bआप\b", r"\bआपक[ाीे]\b", r"\bआपको\b", r"\bआपने\b"],
        "markers_T": [r"\bतुम\b", r"\bतुम्हार[ाीे]\b", r"\bतू\b", r"\bतेर[ाीे]\b"],
        "ambiguous": [],
    },
    "bn": {
        "target": "V",  # আপনি
        "markers_V": [r"\bআপনি\b", r"\bআপনার\b", r"\bআপনাকে\b", r"\bআপনাদের\b"],
        "markers_T": [r"\bতুমি\b", r"\bতোমার\b", r"\bতোমাকে\b", r"\bতুই\b", r"\bতোর\b"],
        "ambiguous": [],
    },
    # ── Восточноазиатские ────────────────────────────────────────────────────
    "zh-Hans": {
        "target": "V",  # 您 — решение ветки feat/web-zh-hans-glossary
        "markers_V": [r"您"],
        "markers_T": [r"你"],
        "ambiguous": [],
    },
    "ja": {
        "target": "V",  # 丁寧語 (です・ます)
        "markers_V": [r"です", r"ます", r"ください", r"ませ"],
        # простая (常体) форма в конце предложения — нарушение регистра
        # словарная форма в подписях кнопок и заголовках — норма японского UI,
        # поэтому маркером считается только простая форма в конце ПРЕДЛОЖЕНИЯ (с 。)
        "markers_T": [
            r"(?<!ま)(?<!で)(?:する|した|なった|だった)。",
            r"(?<!ませ)(?:ない|できる|ある|いる)。",
            r"(?:しろ|やれ|見ろ|しなさい)。",
        ],
        "ambiguous": [],
    },
    "ko": {
        "target": "V",  # 해요/합쇼체 (존댓말)
        "markers_V": [r"습니다", r"세요", r"십시오", r"ᄇ니다", r"입니다"],
        "markers_T": [r"(?:한다|된다|이다|있다|없다)(?:\.|$|\s)", r"해라", r"하라"],
        "ambiguous": [],
        # безличные критерии чек-листов пишутся 한다체 во всех локалях — не обращение
        "skip_key_prefixes": ["catalog.checklists"],
    },
    # ── Языки без грамматического T/V (фиксируем в таблице, не правим) ───────
    "en": {"target": None, "note": "нет T/V; единый нейтральный you"},
    "id": {
        "target": "V",
        "markers_V": [r"\bAnda\b"],
        "markers_T": [
            r"\bkamu\b", r"\bkau\b",
            r"\b(?:akun|kontrak|profil|data|nama|tahap|file|berkas|uang|kesepakatan)mu\b",
        ],
        "ambiguous": [],
        "note": "Anda — вежливое обращение, kamu — фамильярное",
    },
    "vi": {
        "target": "V",
        "markers_V": [r"\bbạn\b", r"\bquý\s+khách\b"],
        "markers_T": [r"\bmày\b", r"\bcậu\b", r"(?<!trẻ )(?<!Trẻ )\bem\b"],
        "ambiguous": [r"\banh\b", r"\bchị\b"],
        "note": "bạn — нейтрально-вежливое; quý khách — сверх-формальное",
    },
    "th": {
        "target": "V",
        "markers_V": [r"คุณ", r"ครับ", r"ค่ะ"],
        "markers_T": [r"มึง", r"เอ็ง"],
        "markers_extra": {"ท่าน — сверхформальное, смешение с คุณ": [r"ท่าน"]},
        "ambiguous": [],
        "note": "คุณ — норма; ท่าน — сверх-формальное, смешение нежелательно",
    },
    "ar": {"target": None, "note": "нет T/V; вежливость — лексическая (حضرتك), не используется"},
    "he": {"target": None, "note": "нет T/V; различие только по роду/числу"},
    "sw": {"target": None, "note": "нет T/V; -ako (ед.) vs -enu (мн.)"},
    "ru": {"target": None, "note": "свой контур продукта, волной не трогается"},
}

SKIP_LOCALES = {"ru", "en"}


def walk(node, prefix: str = "") -> Iterator[tuple[str, str]]:
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk(value, f"{prefix}.{key}" if prefix else key)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk(value, f"{prefix}[{index}]")
    elif isinstance(node, str):
        yield prefix, node


def load_corpus(locale: str) -> list[tuple[str, str, str]]:
    """→ [(контур, ключ, текст)]"""
    rows: list[tuple[str, str, str]] = []
    for path in sorted(glob.glob(os.path.join(WEB_DIR, locale, "*.json"))):
        namespace = os.path.basename(path)[:-5]
        with open(path, encoding="utf-8") as handle:
            for key, text in walk(json.load(handle)):
                rows.append(("web", f"{namespace}:{key}", text))
    pack_path = os.path.join(PACK_DIR, f"{locale}.json")
    if os.path.exists(pack_path):
        with open(pack_path, encoding="utf-8") as handle:
            for key, text in walk(json.load(handle)):
                if key in {"locale", "name", "quality"}:
                    continue
                rows.append(("pack", key, text))
    return rows


def audit(locale: str) -> dict:
    rules = RULES.get(locale, {})
    target = rules.get("target")
    rows = load_corpus(locale)
    result = {
        "locale": locale,
        "target": target,
        "note": rules.get("note", ""),
        "web_total": sum(1 for c, _, _ in rows if c == "web"),
        "pack_total": sum(1 for c, _, _ in rows if c == "pack"),
        "violations": [],
        "extra": [],
        "counts": {"web": 0, "pack": 0},
    }
    if target is None:
        return result

    wrong = "markers_T" if target == "V" else "markers_V"
    right = "markers_V" if target == "V" else "markers_T"
    flags = re.IGNORECASE if rules.get("ignorecase") else 0
    wrong_res = [re.compile(p, flags) for p in rules.get(wrong, [])]
    right_res = [re.compile(p, flags) for p in rules.get(right, [])]
    ambiguous_res = [re.compile(p, flags) for p in rules.get("ambiguous", [])]
    extra_rules = {
        label: [re.compile(p, flags) for p in pats]
        for label, pats in rules.get("markers_extra", {}).items()
    }

    skip_prefixes = tuple(rules.get("skip_key_prefixes", ()))
    for contour, key, text in rows:
        if skip_prefixes and key.startswith(skip_prefixes):
            continue
        hits = sorted({m for rx in wrong_res for m in rx.findall(text) if isinstance(m, str)})
        raw = [rx.pattern for rx in wrong_res if rx.search(text)]
        contexts = []
        for rx in wrong_res:
            for match in list(rx.finditer(text))[:4]:
                start = max(0, match.start() - 45)
                end = min(len(text), match.end() + 45)
                contexts.append(("…" if start else "") + text[start:end].replace("\n", " ") + ("…" if end < len(text) else ""))
        if raw:
            result["violations"].append(
                {
                    "contour": contour,
                    "key": key,
                    "text": text if len(text) <= 400 else text[:400] + "…",
                    "contexts": contexts[:6],
                    "hits": hits or raw,
                    "also_target_register": any(rx.search(text) for rx in right_res),
                    "ambiguous_markers": [rx.pattern for rx in ambiguous_res if rx.search(text)],
                }
            )
            result["counts"][contour] += 1
        for label, pats in extra_rules.items():
            if any(rx.search(text) for rx in pats):
                result["extra"].append(
                    {"label": label, "contour": contour, "key": key,
                     "text": text if len(text) <= 400 else text[:400] + "…"}
                )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("locales", nargs="*", help="локали (по умолчанию — все)")
    parser.add_argument("--list", action="store_true", help="печатать строки-нарушители")
    parser.add_argument("--json", dest="json_out", help="записать полный отчёт в JSON")
    args = parser.parse_args()

    locales = args.locales or sorted(
        name for name in os.listdir(WEB_DIR) if os.path.isdir(os.path.join(WEB_DIR, name))
    )
    reports = []
    print(f"{'locale':10s} {'target':7s} {'web':>5s} {'pack':>5s}  note")
    for locale in locales:
        if locale in SKIP_LOCALES and not args.locales:
            continue
        report = audit(locale)
        reports.append(report)
        target = report["target"] or "—"
        print(
            f"{locale:10s} {target:7s} {report['counts']['web']:5d} "
            f"{report['counts']['pack']:5d}  {report['note']}"
        )
        if args.list:
            for item in report["violations"]:
                flag = "~" if item["also_target_register"] else " "
                print(f"  {flag}[{item['contour']}] {item['key']}")
                for context in item["contexts"]:
                    print(f"      · {context}")
            for item in report["extra"]:
                print(f"  +[{item['contour']}] {item['key']} ({item['label']}) — {item['text'][:140]}")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(reports, handle, ensure_ascii=False, indent=2)
        print(f"\nJSON: {args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
