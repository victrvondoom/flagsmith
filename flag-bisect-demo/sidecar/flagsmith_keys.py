"""Creates, once, the keys Flag Bisect needs on a fresh self-hosted Flagsmith.

Runs inside Flagsmith's own image with `flagsmith shell`, after Flagsmith has bootstrapped
its first organisation and project (ALLOW_ADMIN_INITIATION_VIA_CLI). Writes them to a file
that only the Flag Bisect container reads. Local demo only: the key is an admin key.
"""

import pathlib

from django.conf import settings

from api_keys.models import MasterAPIKey
from environments.models import Environment
from organisations.models import Organisation
from projects.models import Project

out = pathlib.Path("/shared/flagsmith.env")
if out.exists():
    print("flag-bisect: keys already exist, nothing to do")
else:
    organisation = Organisation.objects.get(name=settings.ORGANISATION_NAME)
    project = Project.objects.get(name=settings.PROJECT_NAME, organisation=organisation)
    environment = project.environments.order_by("id").first()
    if environment is None:
        environment = Environment.objects.create(name="Production", project=project)
    _, key = MasterAPIKey.objects.create_key(
        name="flag-bisect-sidecar", organisation=organisation, is_admin=True
    )
    out.write_text(
        "FLAGSMITH_URL=http://flagsmith:8000\n"
        f"FLAGSMITH_ENVIRONMENT_KEY={environment.api_key}\n"
        f"FLAGSMITH_ADMIN_API_KEY={key}\n"
    )
    out.chmod(0o644)
    print(
        f"flag-bisect: connected to project '{project.name}', "
        f"environment '{environment.name}' ({environment.api_key})"
    )
