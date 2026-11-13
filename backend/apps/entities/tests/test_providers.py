from apps.entities.providers import FakeEntityRegistryProvider, RegistryEntityData


def test_fetch_known_llc_returns_director_data():
    provider = FakeEntityRegistryProvider()
    data = provider.fetch_entity_data(FakeEntityRegistryProvider.LLC_WITH_DIRECTOR_INN)
    assert data.found
    assert data.local_form_code == "ru_ooo"
    assert data.director_full_name
    assert data.is_active_in_registry


def test_fetch_known_sole_proprietor_has_no_director():
    provider = FakeEntityRegistryProvider()
    data = provider.fetch_entity_data(FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN)
    assert data.found
    assert data.local_form_code == "ru_ip"
    assert data.director_full_name == ""


def test_fetch_known_self_employed():
    provider = FakeEntityRegistryProvider()
    data = provider.fetch_entity_data(FakeEntityRegistryProvider.SELF_EMPLOYED_INN)
    assert data.found
    assert data.local_form_code == "ru_self_employed"


def test_fetch_liquidated_is_not_active():
    provider = FakeEntityRegistryProvider()
    data = provider.fetch_entity_data(FakeEntityRegistryProvider.LIQUIDATED_INN)
    assert data.found
    assert not data.is_active_in_registry


def test_fetch_unknown_tax_id_returns_not_found():
    provider = FakeEntityRegistryProvider()
    data = provider.fetch_entity_data("no-such-inn")
    assert data.found is False


def test_custom_records_override_and_extend_defaults():
    custom = RegistryEntityData(found=True, name="Custom Co", local_form_code="ru_ooo")
    provider = FakeEntityRegistryProvider(records={"custom-inn": custom})

    assert provider.fetch_entity_data("custom-inn") == custom
    # дефолтные сценарии остаются доступны наряду с добавленными в тесте
    assert provider.fetch_entity_data(FakeEntityRegistryProvider.SOLE_PROPRIETOR_INN).found
