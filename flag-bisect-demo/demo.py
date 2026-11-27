"""Break a demo checkout behind six flag changes and watch Flag Bisect find the culprit.

Uses only Flagsmith's public APIs and the Python standard library:

1. Points the environment's Experimentation events at Flagsmith's own database and
   tells Flag Bisect which events mean failure and success.
2. Simulates shoppers. Each one asks the SDK endpoint which flags it gets, then sends
   `checkout_completed` or `checkout_failed` to the Experimentation events endpoint,
   the same way an app using a Flagsmith SDK would. Shoppers served the culprit fail
   9% of the time instead of 1%.
3. After a healthy baseline, changes six flags at once. One of them is the culprit.
4. Prints what the swarm does. The human decisions are yours, on the Flag Bisect page,
   unless you pass --approve-envelope or --second-token.

    python3 flag-bisect-demo/demo.py --token <API token> --environment <environment key>
"""

import argparse
import json
import random
import threading
import time
import urllib.error
import urllib.request
from typing import Any

FAILURE_EVENT = "checkout_failed"
SUCCESS_EVENT = "checkout_completed"
# name, value before, value after: (enabled, string value)
FLAGS = [
    ("address_autocomplete", (False, None), (True, None)),
    ("promo_banner", (True, "diwali"), (True, "black_friday")),
    ("search_reranker", (True, "bm25"), (True, "hybrid_v2")),
    ("fast_checkout", (False, None), (True, None)),
    ("new_tax_engine", (False, None), (True, None)),
    ("dark_mode_default", (False, None), (True, None)),
]
FINISHED = {"RESOLVED", "NOT_A_FLAG_CHANGE", "INCONCLUSIVE", "ABORTED"}


class Flagsmith:
    def __init__(self, api: str, auth: str) -> None:
        self.api = api.rstrip("/") + "/api"
        self.auth = auth

    def call(
        self,
        method: str,
        path: str,
        body: object = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        request = urllib.request.Request(
            self.api + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                **(headers if headers is not None else {"Authorization": self.auth}),
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode()
        return json.loads(text) if text else None


def auth_header(token: str) -> str:
    """Master API keys contain a dot; user tokens do not."""
    return f"Api-Key {token}" if "." in token else f"Token {token}"


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S"), message, flush=True)


def typed(value: str | None) -> dict[str, str] | None:
    return None if value is None else {"type": "string", "value": value}


def prepare(fs: Flagsmith, env_key: str) -> tuple[int, dict[str, int]]:
    project = fs.call("GET", f"/v1/environments/{env_key}/")["project"]
    connections = fs.call("GET", f"/v1/environments/{env_key}/warehouse-connections/")
    if not connections:
        fs.call(
            "POST",
            f"/v1/environments/{env_key}/warehouse-connections/",
            {"warehouse_type": "postgres", "config": {"source": "flagsmith_database"}},
        )
        log("Experimentation events now go to Flagsmith's own database")
    fs.call(
        "PUT",
        f"/v1/environments/{env_key}/flag-bisect/signal-source/",
        {"failure_event": FAILURE_EVENT, "success_event": SUCCESS_EVENT},
    )
    log(f"Flag Bisect reads {FAILURE_EVENT} and {SUCCESS_EVENT}")
    ids = {}
    for name, before, _ in FLAGS:
        found = fs.call("GET", f"/v1/projects/{project}/features/?search={name}")
        matches = [f["id"] for f in found["results"] if f["name"] == name]
        ids[name] = (
            matches[0]
            if matches
            else fs.call("POST", f"/v1/projects/{project}/features/", {"name": name})[
                "id"
            ]
        )
        set_flag(fs, env_key, ids[name], before)
    log("six flags set to their starting values")
    return project, ids


def set_flag(
    fs: Flagsmith, env_key: str, feature_id: int, state: tuple[bool, str | None]
) -> None:
    fs.call(
        "PATCH",
        f"/__future__/environments/{env_key}/features/{feature_id}/",
        {"environment_default": {"enabled": state[0], "value": typed(state[1])}},
    )


def shoppers(
    fs: Flagsmith, env_key: str, culprit: str, per_second: int, stop: threading.Event
) -> None:
    rng = random.Random()
    sdk = {"X-Environment-Key": env_key, "Content-Type": "application/json"}
    while not stop.is_set():
        started, events = time.time(), []
        for _ in range(per_second):
            identifier = f"shopper-{rng.randrange(20_000)}"
            try:
                flags = fs.call(
                    "GET", f"/v1/identities/?identifier={identifier}", headers=sdk
                )
            except (urllib.error.URLError, TimeoutError):
                continue
            served = {f["feature"]["name"]: f["enabled"] for f in flags["flags"]}
            failure_rate = 0.09 if served.get(culprit) else 0.01
            events.append(
                {
                    "event": FAILURE_EVENT
                    if rng.random() < failure_rate
                    else SUCCESS_EVENT,
                    "identifier": identifier,
                    "timestamp": int(time.time() * 1000),
                }
            )
        if events:
            try:
                fs.call("POST", "/v1/events", {"events": events}, headers=sdk)
            except (urllib.error.URLError, TimeoutError):
                pass
        time.sleep(max(0.0, 1 - (time.time() - started)))


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--api", default="http://localhost:8000")
    parser.add_argument(
        "--token",
        required=True,
        help="an environment admin's API token or admin master API key",
    )
    parser.add_argument(
        "--environment", required=True, help="the environment's client-side key"
    )
    parser.add_argument(
        "--culprit", default="new_tax_engine", choices=[f[0] for f in FLAGS]
    )
    parser.add_argument("--baseline-minutes", type=float, default=10)
    parser.add_argument("--rate", type=int, default=24, help="shoppers per second")
    parser.add_argument(
        "--approve-envelope",
        action="store_true",
        help="approve the envelope with --token",
    )
    parser.add_argument(
        "--second-token",
        help="a different admin's token, to approve the remediation you propose",
    )
    args = parser.parse_args()

    fs = Flagsmith(args.api, auth_header(args.token))
    _, ids = prepare(fs, args.environment)
    stop = threading.Event()
    workers = max(1, args.rate // 6)
    for _ in range(workers):
        threading.Thread(
            target=shoppers,
            args=(fs, args.environment, args.culprit, args.rate // workers, stop),
            daemon=True,
        ).start()
    log(
        f"shoppers are checking out; waiting {args.baseline_minutes:g} minutes for a healthy baseline"
    )
    time.sleep(args.baseline_minutes * 60)
    for name, _, after in FLAGS:
        set_flag(fs, args.environment, ids[name], after)
        log(f"changed {name}")
        time.sleep(2)
    log(
        f"six flags changed; {args.culprit} is the one that breaks checkout. Watch the Flag Bisect page."
    )

    incidents = f"/v1/environments/{args.environment}/flag-bisect/incidents/"
    second = (
        Flagsmith(args.api, auth_header(args.second_token))
        if args.second_token
        else None
    )
    last, acted = "", set()
    try:
        while True:
            time.sleep(10)
            listed = fs.call("GET", incidents)["results"]
            if not listed:
                continue
            incident = fs.call("GET", f"{incidents}{listed[0]['id']}/")
            state = incident["state"]
            if state != last:
                last = state
                log(f"incident #{incident['id']}: {state}")
            if (
                state == "AWAITING_APPROVAL"
                and args.approve_envelope
                and state not in acted
            ):
                acted.add(state)
                fs.call(
                    "POST",
                    f"{incidents}{incident['id']}/approve-envelope/",
                    {"canary_percent": 10},
                )
            if (
                state == "REMEDIATION_PROPOSED"
                and second is not None
                and state not in acted
            ):
                acted.add(state)
                second.call("POST", f"{incidents}{incident['id']}/approve-remediation/")
            if state in FINISHED:
                break
    finally:
        stop.set()
    log("done")


if __name__ == "__main__":
    main()
