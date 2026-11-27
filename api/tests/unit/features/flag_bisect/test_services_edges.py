import typing
from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone
from freezegun.api import FrozenDateTimeFactory
from pytest_django.fixtures import SettingsWrapper
from pytest_structlog import StructuredLogCapture
from rest_framework import status
from rest_framework.test import APIClient

from api_keys.models import MasterAPIKey
from core.dataclasses import AuthorData
from environments.models import Environment
from features.flag_bisect import engine, services
from features.flag_bisect.models import Incident, IncidentState, Probe, Suspect
from features.future.services import get_flag, update_flag
from features.models import Feature
from projects.models import Project
from segments.models import Segment
from users.models import FFAdminUser

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def flag_bisect_enabled(settings: SettingsWrapper) -> None:
    settings.FLAG_BISECT_ENABLED = True


@pytest.fixture(params=["v1", "v2"])
def any_environment(
    request: pytest.FixtureRequest, environment: Environment
) -> Environment:
    if request.param == "v2":
        return typing.cast(
            Environment, request.getfixturevalue("environment_v2_versioning")
        )
    return environment


def _set(
    environment: Environment,
    feature: Feature,
    author: AuthorData,
    enabled: bool,
    value: services.RawValue,
) -> None:
    update_flag(
        environment=environment,
        feature=feature,
        changes={
            "environment_default": {
                "enabled": enabled,
                "value": services._flag_value(value),
            }
        },
        replace=False,
        author=author,
        overwrite_system_segment_overrides=False,
    )


def test_recent_changes__typed_value_changes__report_before_and_after(
    any_environment: Environment,
    project: Project,
    admin_user: FFAdminUser,
    freezer: FrozenDateTimeFactory,
) -> None:
    # Given
    environment = any_environment
    author = AuthorData(user=admin_user)
    freezer.move_to("2026-11-26T10:00:00Z")
    start = timezone.now()
    text = Feature.objects.create(name="banner", project=project)
    number = Feature.objects.create(name="page_size", project=project)
    flag = Feature.objects.create(name="dark_mode", project=project)
    undone = Feature.objects.create(name="undone", project=project)
    freezer.tick(timedelta(seconds=1))
    _set(environment, text, author, True, "diwali")
    _set(environment, number, author, True, 20)
    _set(environment, flag, author, True, False)
    freezer.tick(timedelta(minutes=5))

    # When
    _set(environment, text, author, True, "black_friday")
    _set(environment, number, author, True, 50)
    _set(environment, flag, author, True, True)
    _set(environment, undone, author, True, None)
    freezer.tick(timedelta(seconds=5))
    _set(environment, undone, author, False, None)
    changes = services.recent_changes(
        environment, start + timedelta(minutes=2), timezone.now()
    )

    # Then
    found = {
        c.feature.name: (
            c.before_enabled,
            c.before_value,
            c.after_enabled,
            c.after_value,
        )
        for c in changes
    }
    assert found == {
        "banner": (True, "diwali", True, "black_friday"),
        "page_size": (True, 20, True, 50),
        "dark_mode": (True, False, True, True),
        # Switched on and off again: it is off now, so a revert would turn it on.
        "undone": (True, None, False, None),
    }


def test_same_actor__users_keys_and_mixed__compare_by_identity(
    admin_user: FFAdminUser,
    staff_user: FFAdminUser,
    admin_master_api_key_object: MasterAPIKey,
) -> None:
    # Given / When / Then
    key = admin_master_api_key_object
    assert services._same_actor(admin_user, None, admin_user, None) is True
    assert services._same_actor(admin_user, None, staff_user, None) is False
    assert services._same_actor(None, key, None, key) is True
    assert services._same_actor(admin_user, None, None, key) is False
    assert services._describe(True, "x") == "on (x)"


def _incident(
    environment: Environment, features: list[Feature], **kwargs: typing.Any
) -> Incident:
    incident = Incident.objects.create(
        environment=environment,
        state=kwargs.pop("state", IncidentState.PROBING),
        onset_at=timezone.now() - timedelta(minutes=5),
        baseline_rate=0.01,
        regression_rate=0.09,
        envelope_approved_at=timezone.now(),
        **kwargs,
    )
    for feature in features:
        Suspect.objects.create(
            incident=incident,
            feature=feature,
            before_enabled=False,
            after_enabled=True,
            changed_at=timezone.now() - timedelta(minutes=6),
        )
    return incident


def test_step__not_probing__does_nothing(
    environment: Environment, feature: Feature
) -> None:
    # Given
    incident = _incident(environment, [feature], state=IncidentState.AWAITING_APPROVAL)

    # When
    services.step(incident)

    # Then
    assert not incident.probes.exists()


def test_step__nothing_left_to_learn__exhausts_the_envelope(
    environment: Environment, feature: Feature
) -> None:
    # Given
    incident = _incident(environment, [feature], beliefs=[[[str(feature.id)], 1.0]])

    # When
    services.step(incident)

    # Then
    incident.refresh_from_db()
    assert incident.rounds == incident.max_rounds
    assert not incident.probes.exists()


def _probe(
    incident: Incident, kind: str, canary: tuple[int, int], main: tuple[int, int]
) -> Probe:
    probe = Probe.objects.create(
        incident=incident,
        round=incident.rounds + 1,
        kind=kind,
        started_at=timezone.now() - timedelta(minutes=2),
        settles_at=timezone.now() - timedelta(minutes=1),
        canary_total=canary[0],
        canary_failures=canary[1],
        main_total=main[0],
        main_failures=main[1],
    )
    probe.reverted.set(incident.suspects.all())
    return probe


def test_judge__harmful_canary__aborts_and_cleans_up(
    environment: Environment, feature: Feature
) -> None:
    # Given
    incident = _incident(
        environment, [feature], beliefs=[[[], 0.5], [[str(feature.id)], 0.5]]
    )
    _probe(incident, Probe.Kind.BISECT, canary=(400, 120), main=(5000, 450))

    # When
    services.step(incident)

    # Then
    incident.refresh_from_db()
    assert incident.state == IncidentState.ABORTED


def test_judge__confirmation_does_not_heal__returns_to_probing(
    environment: Environment, feature: Feature, admin_user: FFAdminUser
) -> None:
    # Given
    incident = _incident(
        environment,
        [feature],
        state=IncidentState.CONFIRMING,
        beliefs=[[[], 0.03], [[str(feature.id)], 0.97]],
        conclusion={"ids": [str(feature.id)], "confidence": 0.97},
        envelope_approved_by=admin_user,
    )
    _probe(incident, Probe.Kind.CONFIRM, canary=(1500, 140), main=(15000, 1350))

    # When
    services.step(incident)

    # Then
    incident.refresh_from_db()
    assert incident.state == IncidentState.PROBING
    assert incident.conclusion is None
    assert engine.conclude(services._load_beliefs(incident)).status == "undecided"


def test_watch_environment__after_a_closed_incident__only_reads_newer_traffic(
    environment: Environment, feature: Feature, freezer: FrozenDateTimeFactory
) -> None:
    # Given
    freezer.move_to("2026-11-26T10:00:00Z")
    _incident(environment, [feature], state=IncidentState.RESOLVED)
    for _ in range(10):
        services.record_signals(environment, [services.Signal("x", True)] * 50)
        freezer.tick(timedelta(minutes=1))

    # When
    opened = services.watch_environment(environment)

    # Then
    assert opened is None


def test_clear__override_already_gone__is_tolerated(
    environment: Environment,
    feature: Feature,
    admin_user: FFAdminUser,
    log: StructuredLogCapture,
) -> None:
    # Given
    incident = _incident(environment, [feature], envelope_approved_by=admin_user)
    incident.canary_segment = Segment.objects.create(
        name="canary-without-overrides", project=environment.project
    )
    incident.save()

    # When
    services._clear(incident, incident.suspects.all())

    # Then
    assert log.has("override.already_removed", incident__id=incident.id)


def test_engine__degenerate_inputs__are_handled() -> None:
    # Given
    none_only = [engine.Belief(engine.Hypothesis(()), 1.0)]
    zero = [engine.Belief(engine.Hypothesis(("a",)), 0.0)]

    # When / Then
    assert engine.design_probe(none_only, ["a", "b"], enumerate_up_to=0) is None
    assert engine.update(zero, ["a"], "healed") == zero


def test_approve_remediation__second_actor_through_the_api__restores_and_reports(
    admin_client_original: APIClient,
    admin_master_api_key_client: APIClient,
    environment: Environment,
    project: Project,
    admin_user: FFAdminUser,
) -> None:
    # Given
    feature = Feature.objects.create(name="new_tax_engine", project=project)
    _set(environment, feature, AuthorData(user=admin_user), True, None)
    incident = _incident(
        environment,
        [feature],
        state=IncidentState.IDENTIFIED,
        conclusion={"ids": [str(feature.id)], "confidence": 0.99},
    )
    probe = _probe(incident, Probe.Kind.CONFIRM, canary=(10, 0), main=(10, 1))
    probe.ended_at = timezone.now()
    probe.save()

    def url(name: str) -> str:
        return reverse(
            f"api-v1:environments:flag-bisect:incidents-{name}",
            args=[environment.api_key, incident.id],
        )

    # When
    proposed = admin_client_original.post(url("propose-remediation"))
    approved = admin_master_api_key_client.post(url("approve-remediation"))

    # Then
    assert proposed.status_code == status.HTTP_200_OK
    assert approved.status_code == status.HTTP_200_OK
    assert approved.json()["state"] == "REMEDIATED"
    assert approved.json()["probes"][0]["reverted_features"] == ["new_tax_engine"]
    assert approved.json()["remediation_result"] == {
        "restored": [{"feature": "new_tax_engine", "verified": True}]
    }
    assert (
        get_flag(environment=environment, feature=feature)["environment_default"][
            "enabled"
        ]
        is False
    )


def test_recent_changes__v2_override_only_version__is_not_a_suspect(
    environment_v2_versioning: Environment,
    project: Project,
    admin_user: FFAdminUser,
    freezer: FrozenDateTimeFactory,
) -> None:
    # Given
    environment = environment_v2_versioning
    freezer.move_to("2026-11-26T10:00:00Z")
    start = timezone.now()
    feature = Feature.objects.create(name="checkout", project=project)
    segment = Segment.objects.create(name="beta", project=project)
    freezer.tick(timedelta(seconds=1))

    # When only a segment override changes
    update_flag(
        environment=environment,
        feature=feature,
        changes={
            "segment_overrides": [{"segment": {"id": segment.id}, "enabled": True}]
        },
        replace=False,
        author=AuthorData(user=admin_user),
        overwrite_system_segment_overrides=False,
    )

    # Then
    assert services.recent_changes(environment, start, timezone.now()) == []
