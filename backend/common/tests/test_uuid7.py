import time
import uuid

from common.uuid7 import uuid7


def test_returns_uuid_version_7():
    value = uuid7()
    assert isinstance(value, uuid.UUID)
    assert value.version == 7
    assert value.variant == uuid.RFC_4122


def test_generates_unique_values():
    values = {uuid7() for _ in range(1000)}
    assert len(values) == 1000


def test_time_sortable_across_milliseconds():
    first = uuid7()
    time.sleep(0.002)
    second = uuid7()
    assert first.bytes < second.bytes
