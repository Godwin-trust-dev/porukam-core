from common import circuit


def setup_function() -> None:
    circuit._reset_for_tests()


def test_unknown_provider_has_no_state():
    assert circuit.states() == {}


def test_record_success_tracks_counts_and_stays_closed():
    circuit.record_success("sms_fake")
    circuit.record_success("sms_fake")

    state = circuit.states()["sms_fake"]
    assert state.successes == 2
    assert state.failures == 0
    assert state.state == circuit.CLOSED


def test_record_failure_tracks_counts_without_opening():
    circuit.record_failure("sms_fake")

    state = circuit.states()["sms_fake"]
    assert state.failures == 1
    assert state.state == circuit.CLOSED


def test_states_returns_independent_snapshot():
    circuit.record_success("sms_fake")
    snapshot = circuit.states()
    circuit.record_success("sms_fake")

    assert snapshot["sms_fake"].successes == 1
