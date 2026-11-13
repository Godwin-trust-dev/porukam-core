import pytest

from common.crypto import (
    SubjectKeyDestroyedError,
    decrypt_for_subject,
    destroy_subject_key,
    encrypt_for_subject,
)
from common.models import SubjectKey


@pytest.mark.django_db
def test_roundtrip():
    encrypted = encrypt_for_subject("Иван Иванов", subject_type="user", subject_id="42")
    assert decrypt_for_subject(encrypted.ciphertext, encrypted.key_ref) == "Иван Иванов"


@pytest.mark.django_db
def test_same_subject_reuses_subject_key():
    first = encrypt_for_subject("значение 1", subject_type="user", subject_id="42")
    second = encrypt_for_subject("значение 2", subject_type="user", subject_id="42")
    assert first.key_ref == second.key_ref
    assert SubjectKey.objects.filter(subject_type="user", subject_id="42").count() == 1


@pytest.mark.django_db
def test_different_subjects_get_different_keys():
    a = encrypt_for_subject("значение", subject_type="user", subject_id="1")
    b = encrypt_for_subject("значение", subject_type="user", subject_id="2")
    assert a.key_ref != b.key_ref


@pytest.mark.django_db
def test_ciphertext_is_not_plaintext():
    encrypted = encrypt_for_subject("секрет", subject_type="user", subject_id="1")
    assert b"secret" not in encrypted.ciphertext
    assert "секрет".encode() not in encrypted.ciphertext


@pytest.mark.django_db
def test_unknown_key_ref_raises():
    with pytest.raises(SubjectKeyDestroyedError):
        decrypt_for_subject(b"\x00\x00garbage", "999999")


@pytest.mark.django_db
def test_destroyed_key_cannot_decrypt():
    encrypted = encrypt_for_subject("секрет", subject_type="user", subject_id="7")
    destroy_subject_key("user", "7")
    with pytest.raises(SubjectKeyDestroyedError):
        decrypt_for_subject(encrypted.ciphertext, encrypted.key_ref)


@pytest.mark.django_db
def test_destroy_then_reencrypt_issues_new_key():
    first = encrypt_for_subject("секрет", subject_type="user", subject_id="7")
    destroy_subject_key("user", "7")
    second = encrypt_for_subject("новый секрет", subject_type="user", subject_id="7")
    assert second.key_ref != first.key_ref
    assert decrypt_for_subject(second.ciphertext, second.key_ref) == "новый секрет"
