import typing

from django.conf import settings
from django.db.models import QuerySet
from drf_spectacular.utils import extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.authentication import BaseAuthentication
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.parsers import JSONParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from app.pagination import CustomPagination
from core.dataclasses import AuthorData
from environments.authentication import EnvironmentKeyAuthentication
from environments.permissions.permissions import EnvironmentKeyPermissions
from features.flag_bisect import services
from features.flag_bisect.models import Incident
from features.flag_bisect.permissions import FlagBisectPermission
from features.flag_bisect.serializers import (
    EnvelopeSerializer,
    IncidentListSerializer,
    IncidentSerializer,
    ReasonSerializer,
    SignalsRequestSerializer,
)


class IncidentViewSet(
    viewsets.GenericViewSet[Incident],
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
):
    """Flag Bisect incidents for one environment, and the two human gates."""

    permission_classes = [IsAuthenticated, FlagBisectPermission]
    pagination_class = CustomPagination
    lookup_field = "id"
    lookup_url_kwarg = "incident_id"

    def get_queryset(self) -> QuerySet[Incident]:
        return Incident.objects.filter(
            environment__api_key=self.kwargs.get("environment_api_key")
        )

    def get_serializer_class(self) -> typing.Any:
        return IncidentListSerializer if self.action == "list" else IncidentSerializer

    def _done(self, incident: Incident) -> Response:
        incident.refresh_from_db()
        return Response(IncidentSerializer(incident).data)

    @extend_schema(request=EnvelopeSerializer, responses=IncidentSerializer)
    @action(detail=True, methods=["post"], url_path="approve-envelope")
    def approve_envelope(self, request: Request, **kwargs: typing.Any) -> Response:
        serializer = EnvelopeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        incident = services.approve_envelope(
            self.get_object(),
            AuthorData.from_request(request),
            **serializer.validated_data,
        )
        return self._done(incident)

    @extend_schema(request=ReasonSerializer, responses=IncidentSerializer)
    @action(detail=True, methods=["post"])
    def abort(self, request: Request, **kwargs: typing.Any) -> Response:
        serializer = ReasonSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        incident = services.abort(
            self.get_object(),
            AuthorData.from_request(request),
            serializer.validated_data["reason"],
        )
        return self._done(incident)

    @extend_schema(request=None, responses=IncidentSerializer)
    @action(detail=True, methods=["post"], url_path="propose-remediation")
    def propose_remediation(self, request: Request, **kwargs: typing.Any) -> Response:
        incident = services.propose_remediation(
            self.get_object(), AuthorData.from_request(request)
        )
        return self._done(incident)

    @extend_schema(request=None, responses=IncidentSerializer)
    @action(detail=True, methods=["post"], url_path="approve-remediation")
    def approve_remediation(self, request: Request, **kwargs: typing.Any) -> Response:
        incident = services.approve_remediation(
            self.get_object(), AuthorData.from_request(request)
        )
        return self._done(incident)


class SDKFlagBisectSignalsView(APIView):
    """Request outcomes from your servers. Server-side environment keys only."""

    permission_classes = (EnvironmentKeyPermissions,)
    parser_classes = (JSONParser,)
    throttle_classes = []

    def get_authenticators(self) -> list[BaseAuthentication]:
        return [EnvironmentKeyAuthentication(required_key_prefix="ser.")]

    @extend_schema(request=SignalsRequestSerializer, responses={202: None})
    def post(self, request: Request) -> Response:
        if not settings.FLAG_BISECT_ENABLED:
            raise NotFound()
        serializer = SignalsRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        signals = [
            services.Signal(identifier=s["identifier"], ok=s["ok"])
            for s in serializer.validated_data["signals"]
        ]
        services.record_signals(request.environment, signals)
        return Response(status=status.HTTP_202_ACCEPTED)
