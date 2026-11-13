"""Минимальный DER (X.690) — ровно столько, сколько нужно RFC 3161-клиенту
services/audit_vault/tsa.py (TimeStampReq/TimeStampResp/CMS SignedData) и
тестовому фейку TSA. Своя реализация, а не библиотека: в зависимостях есть
только `cryptography`, у которой нет ASN.1-API общего назначения и нет
поддержки RFC 3161; `asn1crypto`/`rfc3161ng` не добавляем (ADR-135:
четыре HTTP-запроса в сутки не оправдывают новую зависимость в проде).

Поддерживаются только однобайтовые теги (номер < 31) — в структурах
RFC 3161/CMS/X.509 других не встречается. Кодировщик выдаёт строгий DER
(минимальная длина, INTEGER в дополнительном коде, SET OF — отсортирован
вызывающим кодом)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

# --- теги ---
BOOLEAN = 0x01
INTEGER = 0x02
BIT_STRING = 0x03
OCTET_STRING = 0x04
NULL = 0x05
OID = 0x06
UTF8_STRING = 0x0C
SEQUENCE = 0x30
SET = 0x31
GENERALIZED_TIME = 0x18
CONTEXT_CONSTRUCTED = 0xA0  # [n] EXPLICIT / IMPLICIT constructed: 0xA0 | n
CONTEXT_PRIMITIVE = 0x80  # [n] IMPLICIT primitive: 0x80 | n


class DerError(ValueError):
    """Некорректный DER или не та структура, что ожидалась."""


# ---------------------------------------------------------------------------
# Кодирование
# ---------------------------------------------------------------------------


def encode_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    body = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def tlv(tag: int, content: bytes) -> bytes:
    return bytes([tag]) + encode_length(len(content)) + content


def sequence(*parts: bytes) -> bytes:
    return tlv(SEQUENCE, b"".join(parts))


def set_of(*parts: bytes) -> bytes:
    """SET OF — DER требует сортировки элементов по их кодированию."""
    return tlv(SET, b"".join(sorted(parts)))


def integer(value: int) -> bytes:
    if value == 0:
        return tlv(INTEGER, b"\x00")
    length = (value.bit_length() + 8) // 8  # +1 бит знака
    return tlv(INTEGER, value.to_bytes(length, "big", signed=True))


def boolean(value: bool) -> bytes:
    return tlv(BOOLEAN, b"\xff" if value else b"\x00")


def null() -> bytes:
    return tlv(NULL, b"")


def octet_string(value: bytes) -> bytes:
    return tlv(OCTET_STRING, value)


def utf8_string(value: str) -> bytes:
    return tlv(UTF8_STRING, value.encode("utf-8"))


def oid(dotted: str) -> bytes:
    arcs = [int(a) for a in dotted.split(".")]
    if len(arcs) < 2:
        raise DerError(f"OID слишком короткий: {dotted}")
    body = bytearray([arcs[0] * 40 + arcs[1]])
    for arc in arcs[2:]:
        chunk = bytearray([arc & 0x7F])
        arc >>= 7
        while arc:
            chunk.insert(0, 0x80 | (arc & 0x7F))
            arc >>= 7
        body.extend(chunk)
    return tlv(OID, bytes(body))


def generalized_time(moment: datetime) -> bytes:
    """GeneralizedTime в DER: только UTC, `YYYYMMDDHHMMSS[.fff]Z`, без
    хвостовых нулей в долях секунды (RFC 5280 §4.1.2.5.2 — доли секунды
    в сертификатах запрещены, в TSTInfo.genTime — допустимы, RFC 3161 §2.4.2)."""
    moment = moment.astimezone(UTC)
    text = moment.strftime("%Y%m%d%H%M%S")
    if moment.microsecond:
        text += "." + f"{moment.microsecond:06d}".rstrip("0")
    return tlv(GENERALIZED_TIME, (text + "Z").encode("ascii"))


def explicit(number: int, content: bytes) -> bytes:
    """[number] EXPLICIT — обёртка над уже закодированным элементом."""
    return tlv(CONTEXT_CONSTRUCTED | number, content)


def implicit_constructed(number: int, content: bytes) -> bytes:
    """[number] IMPLICIT над SEQUENCE/SET: тот же content, тег заменён."""
    return tlv(CONTEXT_CONSTRUCTED | number, content)


def algorithm_identifier(dotted: str, *, with_null: bool = True) -> bytes:
    """AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL }.
    Для SHA-2 параметры — NULL (так делает openssl, и так ждут старые
    верификаторы); для ECDSA-подписей параметров быть не должно."""
    return sequence(oid(dotted), null()) if with_null else sequence(oid(dotted))


# ---------------------------------------------------------------------------
# Разбор
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Node:
    tag: int
    content: bytes
    raw: bytes  # полный TLV — нужен для повторного хеширования/подписи

    @property
    def constructed(self) -> bool:
        return bool(self.tag & 0x20)

    @property
    def context_number(self) -> int | None:
        """Номер [n] для контекстно-специфичных тегов, иначе None."""
        return self.tag & 0x1F if (self.tag & 0xC0) == 0x80 else None

    def children(self) -> list[Node]:
        if not self.constructed:
            raise DerError(f"тег 0x{self.tag:02x} — примитив, вложенных элементов нет")
        return decode_all(self.content)


def decode_one(data: bytes, offset: int = 0) -> tuple[Node, int]:
    """Читает один TLV начиная с `offset`, возвращает (узел, смещение за ним)."""
    if offset >= len(data):
        raise DerError("неожиданный конец данных")
    tag = data[offset]
    if tag & 0x1F == 0x1F:
        raise DerError("многобайтовые теги не поддерживаются")
    pos = offset + 1
    if pos >= len(data):
        raise DerError("неожиданный конец данных (длина)")
    first = data[pos]
    pos += 1
    if first < 0x80:
        length = first
    else:
        n = first & 0x7F
        if n == 0 or n > 4:
            raise DerError("недопустимая форма длины")
        if pos + n > len(data):
            raise DerError("неожиданный конец данных (длина)")
        length = int.from_bytes(data[pos : pos + n], "big")
        pos += n
    end = pos + length
    if end > len(data):
        raise DerError("длина элемента выходит за пределы данных")
    return Node(tag=tag, content=data[pos:end], raw=data[offset:end]), end


def decode(data: bytes) -> Node:
    """Ровно один элемент на всю строку байтов (никаких хвостов)."""
    node, end = decode_one(data)
    if end != len(data):
        raise DerError("лишние байты после элемента")
    return node


def decode_all(data: bytes) -> list[Node]:
    nodes: list[Node] = []
    offset = 0
    while offset < len(data):
        node, offset = decode_one(data, offset)
        nodes.append(node)
    return nodes


def expect(node: Node, tag: int, what: str) -> Node:
    if node.tag != tag:
        raise DerError(f"{what}: ожидался тег 0x{tag:02x}, получен 0x{node.tag:02x}")
    return node


def decode_integer(node: Node) -> int:
    expect(node, INTEGER, "INTEGER")
    return int.from_bytes(node.content, "big", signed=True)


def decode_boolean(node: Node) -> bool:
    expect(node, BOOLEAN, "BOOLEAN")
    return node.content != b"\x00"


def decode_oid(node: Node) -> str:
    expect(node, OID, "OID")
    body = node.content
    if not body:
        raise DerError("пустой OID")
    arcs: list[int] = []
    value = 0
    for i, byte in enumerate(body):
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            if not arcs:
                first = min(value // 40, 2)
                arcs.extend([first, value - first * 40])
            else:
                arcs.append(value)
            value = 0
        elif i == len(body) - 1:
            raise DerError("незавершённый OID")
    return ".".join(str(a) for a in arcs)


def decode_generalized_time(node: Node) -> datetime:
    expect(node, GENERALIZED_TIME, "GeneralizedTime")
    text = node.content.decode("ascii")
    if not text.endswith("Z"):
        raise DerError(f"GeneralizedTime не в UTC: {text}")
    body = text[:-1]
    fraction = 0
    if "." in body:
        body, frac = body.split(".", 1)
        fraction = int((frac + "000000")[:6])
    if len(body) == 12:  # без секунд (допускается X.680, в DER — нет, но встречается)
        body += "00"
    if len(body) != 14:
        raise DerError(f"GeneralizedTime неизвестного формата: {text}")
    return datetime.strptime(body, "%Y%m%d%H%M%S").replace(microsecond=fraction, tzinfo=UTC)


def decode_algorithm_identifier(node: Node) -> str:
    """Возвращает OID алгоритма; параметры (если есть) игнорируются —
    для RSASSA-PSS они разбираются отдельно в tsa.py."""
    expect(node, SEQUENCE, "AlgorithmIdentifier")
    parts = node.children()
    if not parts:
        raise DerError("AlgorithmIdentifier без алгоритма")
    return decode_oid(parts[0])
