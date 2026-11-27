# Flagsmith API findings for Flag Bisect (specialist, from source in /home/user/flagsmith/api, 2026-11-26; not run live by the specialist)

- Read/write flag state, both versioning modes: `GET|PATCH /api/__future__/environments/{env_api_key}/features/{feature_id}/` (features/future/views.py). Body `{"environment_default":{"enabled","value":{"type":"string|integer|boolean","value"}},"segment_overrides":[{"segment":{"id"},"priority","enabled","value"}]}`. PATCH merges; NEVER PUT (deletes unlisted overrides). 409 `change_requests_enabled` when change requests are on. Experimental API.
- Remove override: `DELETE /api/__future__/environments/{key}/features/{fid}/segment-overrides/{segment_id}/`.
- Segments: `POST /api/v1/projects/{p}/segments/` `{"name","project","rules":[{"type":"ALL","rules":[{"type":"ANY","rules":[],"conditions":[...]}],"conditions":[]}]}`; MANAGE_SEGMENTS; delete removes its overrides.
- Evaluation: identity override > lowest-priority matching segment override > environment default (flag_engine evaluator.py:144-157).
- Audit: `GET /api/v1/projects/{p}/audit/` (filters project, environments, search; no date filter) and `/{id}/` with change_details [{field, old, new}] (v1 only; v2 has EF_VERSION entries without a diff).
- v2 history: `/api/v1/environments/{env_id}/features/{fid}/versions/?is_live=true`, `/api/v1/environment-feature-versions/{uuid}/` (previous_version_uuid), `.../featurestates/`.
- Webhooks: `POST /api/v1/environments/{key}/webhooks/` `{url, enabled, secret}`. Payload `{event_type: FLAG_UPDATED|FLAG_DELETED|NEW_VERSION_PUBLISHED, data:{new_state, previous_state, changed_by, timestamp}}`; header X-Flagsmith-Signature = hex HMAC-SHA256(secret, json.dumps(data, sort_keys=True)).
- SDK identify: `POST /api/v1/identities/` evaluates with traits sent in the request.
- Code references: `GET /api/v1/projects/{p}/features/{f}/code-references/`. Tags: `/api/v1/projects/{p}/tags/`, feature `tags: [ids]`.
- Adapter bug: getAssignmentConfig filters /api/v1/features/featurestates/ by feature_name (ignored; valid filters environment, feature, feature_segment, features/views.py:986). Fix: `?feature=<id>`.
- Adapter only does GET/POST; needs PATCH/DELETE (never retried).
- Caveats: identity overrides beat the canary; change requests block writes (409); system segments protected.
