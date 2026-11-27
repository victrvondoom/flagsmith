from rest_framework_nested import routers  # type: ignore[import-untyped]

from features.flag_bisect.views import IncidentViewSet

app_name = "flag-bisect"

router = routers.DefaultRouter()
router.register(r"incidents", IncidentViewSet, basename="incidents")

urlpatterns = router.urls
