"""Нечёткий поиск сфер для `GET /spheres?q=` (ADR-097) — чистые функции без
ORM/HTTP: вход — запрос и кандидаты-строки, выход — ранжированные коды сфер.

Прежний `startswith` по локализованному имени (ADR-091 §4) не находил ничего
по запросам из собственного плейсхолдера UI («ремонт кухни», «сборка шкафа»).
Правила подобраны по практике каталожных поисков (Baymard/Algolia/Meilisearch):

- нормализация: нижний регистр, ё→е, всё не-буквенно-цифровое — пробел;
- по-токенно: точное слово > префикс > подстрока > опечатка
  (Дамерау-Левенштейн, допуск от длины токена как у Meilisearch:
  до 3 символов — 0, 4–7 — 1, от 8 — 2);
- достаточно совпадения ОДНОГО токена запроса («ремонт кухни» находит
  «Ремонт и строительство», хотя слова «кухни» в имени нет), но чем больше
  токенов совпало — тем выше результат;
- кандидаты сферы — не только имя, но и имена её категорий («маникюр» →
  категория beauty.nails → сфера «Красота»); совпадение по категории
  ранжируется чуть ниже совпадения по имени.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Допуск опечаток от длины токена (порог Meilisearch: 1 опечатка с 4 символов
# было бы шумно для коротких русских корней — оставлен их дефолт 5/9,
# сдвинутый на 4/8: слова каталога короткие, «римонт» (6) должен находиться).
_TYPO_1_MIN_LEN = 4
_TYPO_2_MIN_LEN = 8

# Подстрочное совпадение — только для токенов от 3 символов: двухбуквенный
# токен находится ВНУТРИ слишком многих слов («no» в «Renovation»").
_SUBSTRING_MIN_LEN = 3

# Баллы за качество совпадения токена (иерархия важнее абсолютных величин).
_SCORE_EXACT = 100
_SCORE_PREFIX = 85
_SCORE_SUBSTRING = 65
_SCORE_TYPO_BASE = 60  # минус 10 за каждую единицу расстояния

# Совпадение по имени категории слабее совпадения по имени сферы.
_CATEGORY_WEIGHT = 0.8

# Целиком-фразовый бонус: нормализованный запрос — подстрока имени сферы
# (различает «Ремонт и строительство» и «Ремонт техники» на запросе
# «ремонт и строительство»).
_PHRASE_BONUS = 200


def normalize(text: str) -> str:
    """Нижний регистр, ё→е, не-буквенно-цифровое → пробел, схлопнуть пробелы."""
    lowered = text.lower().replace("ё", "е")
    cleaned = "".join(ch if ch.isalnum() else " " for ch in lowered)
    return " ".join(cleaned.split())


def tokenize(text: str) -> list[str]:
    return normalize(text).split()


def damerau_levenshtein(a: str, b: str, *, cutoff: int) -> int:
    """Расстояние Дамерау-Левенштейна (с транспозицией соседних символов —
    самый частый вид опечатки) с отсечкой: всё, что больше `cutoff`,
    возвращается как `cutoff + 1` — точное значение дальше не нужно."""
    if abs(len(a) - len(b)) > cutoff:
        return cutoff + 1
    # Классическое ДП по строкам; строки каталога короткие, оптимизаций
    # сверх отсечки по разнице длин не требуется.
    prev_prev: list[int] = []
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            current[j] = min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and ca == b[j - 2] and cb == a[i - 2]:
                current[j] = min(current[j], prev_prev[j - 2] + 1)
        prev_prev, prev = prev, current
        if min(prev) > cutoff:
            return cutoff + 1
    return prev[len(b)]


def _max_typos(token_len: int) -> int:
    if token_len >= _TYPO_2_MIN_LEN:
        return 2
    if token_len >= _TYPO_1_MIN_LEN:
        return 1
    return 0


def _token_score(query_token: str, word: str) -> float:
    if query_token == word:
        return _SCORE_EXACT
    if word.startswith(query_token):
        return _SCORE_PREFIX
    if len(query_token) >= _SUBSTRING_MIN_LEN and query_token in word:
        return _SCORE_SUBSTRING
    allowed = _max_typos(len(query_token))
    if allowed:
        distance = damerau_levenshtein(query_token, word, cutoff=allowed)
        if distance <= allowed:
            return _SCORE_TYPO_BASE - 10 * distance
    return 0.0


@dataclass(frozen=True)
class SphereCandidate:
    """Кандидат ранжирования: код сферы + строки, по которым её можно найти."""

    code: str
    names: tuple[str, ...]  # локализованные/фолбэк имена самой сферы
    category_names: tuple[str, ...] = field(default=())  # имена её категорий


def _best_over_texts(query_token: str, texts: tuple[str, ...], weight: float) -> float:
    best = 0.0
    for text in texts:
        for word in tokenize(text):
            best = max(best, _token_score(query_token, word) * weight)
    return best


def rank_spheres(query: str, candidates: list[SphereCandidate]) -> list[str]:
    """Коды сфер, отсортированные по релевантности запросу; сферы без
    единого совпавшего токена не возвращаются. Пустой запрос — пустой
    список (показ «всех сфер» — забота вызывающей стороны, не поиска)."""
    query_tokens = tokenize(query)
    if not query_tokens:
        return []

    normalized_query = normalize(query)
    ranked: list[tuple[int, float, str]] = []
    for candidate in candidates:
        matched = 0
        total = 0.0
        for token in query_tokens:
            score = max(
                _best_over_texts(token, candidate.names, 1.0),
                _best_over_texts(token, candidate.category_names, _CATEGORY_WEIGHT),
            )
            if score > 0:
                matched += 1
                total += score
        if matched == 0:
            continue
        if any(normalized_query in normalize(name) for name in candidate.names):
            total += _PHRASE_BONUS
        ranked.append((matched, total, candidate.code))

    ranked.sort(key=lambda item: (-item[0], -item[1], item[2]))
    return [code for _, _, code in ranked]
