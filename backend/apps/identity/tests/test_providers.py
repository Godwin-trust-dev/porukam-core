import pytest

from apps.identity.providers import FakeEsiaProvider, InvalidVerificationCodeError


def test_authorize_url_contains_state_and_code_challenge():
    provider = FakeEsiaProvider()
    url = provider.authorize_url(state="s1", code_challenge="cc1")
    assert "state=s1" in url
    assert "code_challenge=cc1" in url


def test_complete_parses_deterministic_code():
    provider = FakeEsiaProvider()
    identity = provider.complete(code="Иван Иванов|7701234567")
    assert identity.full_name == "Иван Иванов"
    assert identity.tax_id == "7701234567"
    assert identity.attributes == {"tax_id": "7701234567"}


@pytest.mark.parametrize("code", ["", "no-pipe-here", "|7701234567", "Иван Иванов|", "a|b|c"])
def test_complete_rejects_malformed_code(code):
    provider = FakeEsiaProvider()
    with pytest.raises(InvalidVerificationCodeError):
        provider.complete(code=code)
