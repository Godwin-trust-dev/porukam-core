import pytest

from common.fsm import InvalidTransitionError, StateMachine, Transition


def make_contract_fsm() -> StateMachine:
    """Упрощённая машина согласования договора (tech-spec.md §6.1) для теста."""
    return StateMachine(
        states=["draft", "under_review", "pending_signature", "signed"],
        transitions=[
            Transition(name="submit_for_review", source="draft", target="under_review"),
            Transition(name="freeze", source="under_review", target="pending_signature"),
            Transition(name="sign", source="pending_signature", target="signed"),
            Transition(name="request_changes", source="pending_signature", target="under_review"),
        ],
    )


def test_allowed_transition_returns_target_state():
    fsm = make_contract_fsm()
    transition = fsm.assert_transition("submit_for_review", source="draft")
    assert transition.target == "under_review"


def test_transition_from_wrong_source_is_forbidden():
    fsm = make_contract_fsm()
    with pytest.raises(InvalidTransitionError):
        fsm.assert_transition("sign", source="draft")


def test_unknown_transition_name_is_forbidden():
    fsm = make_contract_fsm()
    with pytest.raises(InvalidTransitionError):
        fsm.assert_transition("teleport", source="draft")


def test_can_transition_boolean_check():
    fsm = make_contract_fsm()
    assert fsm.can_transition("submit_for_review", source="draft") is True
    assert fsm.can_transition("sign", source="draft") is False


def test_allowed_transitions_lists_all_options_from_state():
    fsm = make_contract_fsm()
    names = {t.name for t in fsm.allowed_transitions("pending_signature")}
    assert names == {"sign", "request_changes"}


def test_rollback_transition_is_modeled_explicitly():
    """Правка после pending_signature возвращает в under_review (dev-setup.md §3)."""
    fsm = make_contract_fsm()
    transition = fsm.assert_transition("request_changes", source="pending_signature")
    assert transition.target == "under_review"


def test_rejects_transition_referencing_unknown_state():
    with pytest.raises(ValueError):
        StateMachine(
            states=["draft", "signed"],
            transitions=[Transition(name="sign", source="draft", target="unknown_state")],
        )


def test_rejects_duplicate_transition_from_same_source():
    with pytest.raises(ValueError):
        StateMachine(
            states=["draft", "under_review", "signed"],
            transitions=[
                Transition(name="go", source="draft", target="under_review"),
                Transition(name="go", source="draft", target="signed"),
            ],
        )
