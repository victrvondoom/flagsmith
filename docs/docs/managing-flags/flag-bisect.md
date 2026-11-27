---
title: Flag Bisect
sidebar_label: Flag Bisect
sidebar_position: 5
---

When errors rise shortly after several flags changed, Flag Bisect finds which change caused it without rolling all of
them back. It reverts a subset of the recent changes for a small, randomised canary segment, compares that segment with
everyone else, and repeats until one change (or a pair that only breaks together) explains the regression. A person
approves before anything changes, and restoring the culprit for everyone needs a second person.

Flag Bisect is turned off by default. Set `FLAG_BISECT_ENABLED=true` on the API and the task processor to turn it on.

## How it works

1. **Your servers report outcomes.** Send whether each request succeeded, with the identity it was served for, to
   `POST /api/v1/flag-bisect/signals/` using a server-side environment key.
2. **An incident opens.** When the failure rate shifts, Flag Bisect dates the onset and lists every change to an
   environment default in the two hours before it, from Flagsmith's own history (feature versions with versioning on, or
   the flag's history records without it).
3. **An environment admin approves the envelope.** The envelope sets the canary size (1 to 20% of identities), the
   maximum number of rounds and minutes. Nothing changes in Flagsmith until it is approved.
4. **Probes.** Each round reverts some of the changes for the canary segment only, through segment overrides. Everyone
   else keeps today's flags. After 30 seconds, outcomes are counted separately for identities inside and outside the
   segment, using the same percentage split the SDKs evaluate. A sequential test decides whether the canary healed.
5. **Confirmation.** Before anyone acts, one more probe reverts only the suspected culprit.
6. **Remediation.** One person proposes restoring the culprit for everyone and a different person approves it. Flag
   Bisect writes the environment default and reads it back. Other changes stay as they are.

The canary is a system segment named `flag-bisect-<incident>-canary`. It is deleted when the incident ends.

## Reporting outcomes

```bash
curl -X POST https://<your-flagsmith>/api/v1/flag-bisect/signals/ \
  -H "X-Environment-Key: ser.<server-key>" \
  -H "Content-Type: application/json" \
  -d '{"signals": [{"identifier": "user-42", "ok": false}, {"identifier": "user-43", "ok": true}]}'
```

Send up to 1,000 outcomes per request. Use the same identifier you pass to the SDK, so the canary is matched exactly.

## API

Under `/api/v1/environments/<environment_api_key>/flag-bisect/incidents/`, for environment admins:

| Method and path                   | Purpose                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /`                           | Incidents, newest first                                                                    |
| `GET /<id>/`                      | Suspects with prior and posterior odds, probes, leading explanations and the agents' trail |
| `POST /<id>/approve-envelope/`    | Approve the envelope; optional `canary_percent`, `max_rounds`, `max_minutes`               |
| `POST /<id>/abort/`               | Stop and remove the canary; `reason` required                                              |
| `POST /<id>/propose-remediation/` | Propose restoring the culprit for everyone                                                 |
| `POST /<id>/approve-remediation/` | Approve it, as a different user or API key                                                 |

Every action is recorded in the audit log.

## Things to know

- With change requests enabled for the environment, Flag Bisect refuses to change flags.
- Identity overrides take precedence over the canary's segment overrides.
- It needs traffic: the smaller the regression, the more requests each probe needs.
- It handles one culprit or a pair of changes that only fail together. Three or more interacting changes end as
  inconclusive.
- A probe can be wrong (each has a nominal 5% error rate), which is why the confirmation probe runs before anyone acts.
