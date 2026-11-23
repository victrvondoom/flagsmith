import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveSubjectRef, diffContracts, environmentFingerprint, evaluateContract, issueIdentityToken, mergeSurfaceFeatures, observationDrift, parseContract,
  parseManifestText, silentSurfaces, validateCombination, validateRawSubject, verifyIdentityToken, configDrift,
} from "./index.ts";
import { EXAMPLE_PATH, FEATURES, NOW, observe, SUBJECT, exampleContract } from "./support.ts";

const evalAt = (obs: ReturnType<typeof observe>, c = exampleContract(), now = NOW, canonical?: Map<string, string | null>) => evaluateContract(c, obs, { nowMs: now, ...(canonical ? { canonical } : {}) });

describe("contract manifest", () => {
  it("parse__example_yaml__is_valid_and_normalised", () => {
    const r = parseContract(readFileSync(EXAMPLE_PATH, "utf8"));
    assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
    assert.equal(r.contract.surfaces.length, 4);
    assert.deepEqual(r.contract.constraints[0]!.requires.payment_route, ["upi_intent_v2"]);
    assert.equal(r.contract.freshness.maxAgeSeconds, 900);
  });

  it("parse__json_manifest__is_accepted_like_yaml", () => {
    const yaml = parseManifestText(readFileSync(EXAMPLE_PATH, "utf8"));
    assert.ok(yaml.ok);
    assert.ok(parseContract(JSON.stringify(yaml.value)).ok);
  });

  it("parse__broken_yaml__reports_the_position", () => {
    const r = parseContract("contract:\n  id: x\n   version: 1\n");
    assert.ok(!r.ok);
    assert.match(r.issues[0]!.path, /line \d+/);
  });

  it("parse__missing_required_fields__lists_every_problem_with_paths", () => {
    const r = parseContract({ contract: { id: "Bad ID" }, surfaces: [], variants: {} });
    assert.ok(!r.ok);
    const paths = r.issues.map((i) => i.path);
    for (const p of ["contract.id", "contract.version", "experiment", "surfaces", "variants"]) assert.ok(paths.includes(p), `${p} in ${paths.join(",")}`);
    assert.ok(r.issues.every((i) => i.code === "CONTRACT_INVALID"));
  });

  it("parse__duplicate_surface__is_rejected", () => {
    const r = parseContract({ ...parseManifestTextValue(), surfaces: [{ id: "web" }, { id: "web" }] });
    assert.ok(!r.ok && r.issues.some((i) => /duplicate surface/.test(i.message)));
  });

  it("parse__surface_reports_unknown_feature__is_rejected", () => {
    const raw = parseManifestTextValue(); raw.surfaces[0].features = ["not_a_feature"];
    const r = parseContract(raw);
    assert.ok(!r.ok && r.issues.some((i) => /unknown feature "not_a_feature"/.test(i.message)));
  });

  it("parse__variant_missing_a_feature__is_rejected", () => {
    const raw = parseManifestTextValue(); delete raw.variants.upi_first.retry_policy;
    const r = parseContract(raw);
    assert.ok(!r.ok && r.issues.some((i) => /missing feature "retry_policy"/.test(i.message)));
  });

  it("parse__constraint_with_unknown_value__is_rejected", () => {
    const raw = parseManifestTextValue(); raw.constraints[0].requires.payment_route = "made_up";
    const r = parseContract(raw);
    assert.ok(!r.ok && r.issues.some((i) => /made_up/.test(i.message)));
  });

  it("parse__contradictory_constraints__are_detected", () => {
    const raw = parseManifestTextValue();
    raw.constraints.push({ id: "conflict", when: { checkout_ui: "upi_first" }, requires: { payment_route: "legacy" } });
    const r = parseContract(raw);
    assert.ok(!r.ok && r.issues.some((i) => /can apply together but require different values/.test(i.message)), JSON.stringify(!r.ok && r.issues));
  });

  it("parse__variant_violating_its_own_constraint__is_a_contradiction", () => {
    const raw = parseManifestTextValue(); raw.variants.upi_first.payment_route = "legacy";
    const r = parseContract(raw);
    assert.ok(!r.ok && r.issues.some((i) => /variants\.upi_first/.test(i.path) && /violates constraint "upi-needs-v2-route"/.test(i.message)));
  });

  it("parse__unknown_guardrail_and_bad_freshness__are_rejected", () => {
    const raw = parseManifestTextValue(); raw.guardrails = ["nope"]; raw.freshness = { max_age_seconds: 100, correlation_window_seconds: 10 };
    const r = parseContract(raw);
    assert.ok(!r.ok);
    assert.ok(r.issues.some((i) => /unknown guardrail/.test(i.message)) && r.issues.some((i) => /correlation_window_seconds must be >=/.test(i.message)));
  });

  it("parse__feature_no_surface_reports__is_only_a_warning", () => {
    const raw = parseManifestTextValue(); raw.surfaces = raw.surfaces.filter((s: any) => s.id !== "risk-engine");
    const r = parseContract(raw);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => /no surface reports feature "retry_policy"/.test(w.message)));
  });
});
function parseManifestTextValue(): any {
  const t = parseManifestText(readFileSync(EXAMPLE_PATH, "utf8"));
  if (!t.ok) throw new Error("example unreadable");
  return structuredClone(t.value);
}

describe("combination validator", () => {
  const c = exampleContract();
  it("validate__correct_treatment__is_valid", () => {
    assert.equal(validateCombination(c, { variant: "upi_first", features: FEATURES.upi_first!, checkConstraints: true }).status, "COMBINATION_VALID");
  });
  it("validate__upi_ui_with_legacy_route__is_a_violation_naming_both_rules", () => {
    const r = validateCombination(c, { variant: "upi_first", features: { checkout_ui: "upi_first", payment_route: "legacy", retry_policy: "standard" }, checkConstraints: true });
    assert.equal(r.status, "COMBINATION_VIOLATION");
    assert.ok(r.findings.some((f) => f.kind === "constraint_requires" && f.feature === "payment_route" && f.expected === "upi_intent_v2" && f.actual === "legacy"));
    assert.ok(r.findings.some((f) => f.kind === "constraint_requires" && f.feature === "retry_policy"));
    assert.ok(r.findings.some((f) => f.kind === "variant_value"));
  });
  it("validate__forbidden_combination__is_a_violation", () => {
    const r = validateCombination(c, { variant: "control", features: { checkout_ui: "classic", payment_route: "upi_intent_v2", retry_policy: "standard" }, checkConstraints: true });
    assert.ok(r.findings.some((f) => f.kind === "constraint_forbids" && f.constraintId === "classic-never-uses-upi-route"));
  });
  it("validate__missing_required_feature__is_reported", () => {
    const r = validateCombination(c, { variant: "upi_first", features: { checkout_ui: "upi_first" } });
    assert.equal(r.status, "MISSING_REQUIRED_FEATURE");
    assert.deepEqual(r.findings.map((f) => f.feature).sort(), ["payment_route", "retry_policy"]);
  });
  it("validate__constraint_dependency_not_reported__is_missing_not_assumed_valid", () => {
    const r = validateCombination(c, { variant: "upi_first", features: { checkout_ui: "upi_first" }, requiredFeatures: [], checkConstraints: true });
    assert.ok(r.findings.some((f) => f.code === "MISSING_REQUIRED_FEATURE" && f.constraintId === "upi-needs-v2-route"));
  });
  it("validate__unknown_value_feature_and_variant__are_unknown_not_violations", () => {
    assert.equal(validateCombination(c, { variant: "upi_first", features: { checkout_ui: "hologram" }, requiredFeatures: [] }).status, "UNKNOWN_FEATURE_VALUE");
    assert.equal(validateCombination(c, { variant: "upi_first", features: { surprise: "x" }, requiredFeatures: [] }).findings[0]!.kind, "unknown_feature");
    assert.equal(validateCombination(c, { variant: "blue", features: {} }).findings[0]!.kind, "unknown_variant");
  });
  it("merge__same_feature_different_values__is_a_contradiction", () => {
    const m = mergeSurfaceFeatures([{ surfaceId: "web-checkout", features: { checkout_ui: "classic" } }, { surfaceId: "mobile-checkout", features: { checkout_ui: "upi_first" } }]);
    assert.equal(m.conflicts.length, 1);
    assert.match(m.conflicts[0]!.actual, /mobile-checkout/);
  });
});

describe("canonical identity", () => {
  const secret = "s".repeat(40);
  it("deriveSubjectRef__same_input__is_stable_and_pseudonymous", () => {
    const a = deriveSubjectRef(secret, "authenticated", "cust-42");
    assert.equal(a, deriveSubjectRef(secret, "authenticated", "cust-42"));
    assert.notEqual(a, deriveSubjectRef(secret, "authenticated", "cust-43"));
    assert.notEqual(a, deriveSubjectRef("t".repeat(40), "authenticated", "cust-42"));
    assert.match(a, /^sub_[A-Za-z0-9_-]{32}$/);
    assert.doesNotMatch(a, /cust-42/);
    assert.match(deriveSubjectRef(secret, "anonymous", "anon-1"), /^anon_/);
  });
  it("validateRawSubject__emails_and_junk__are_rejected", () => {
    assert.ok(!validateRawSubject("jane@example.com").ok);
    assert.ok(!validateRawSubject("has space").ok);
    assert.ok(!validateRawSubject("").ok);
    assert.ok(validateRawSubject("cust-42").ok);
  });
  it("token__roundtrip_expiry_tampering_and_wrong_key", () => {
    const sub = deriveSubjectRef(secret, "authenticated", "cust-42");
    const t = issueIdentityToken(secret, sub, "authenticated", NOW, 60);
    const ok = verifyIdentityToken(secret, t, NOW + 1000);
    assert.ok(ok.ok && ok.sub === sub);
    assert.deepEqual(verifyIdentityToken(secret, t, NOW + 61_000), { ok: false, reason: "expired" });
    assert.deepEqual(verifyIdentityToken("t".repeat(40), t, NOW), { ok: false, reason: "bad_signature" });
    const [h, body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: deriveSubjectRef(secret, "authenticated", "someone-else"), kind: "authenticated", iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 600 })).toString("base64url");
    assert.deepEqual(verifyIdentityToken(secret, `${h}.${forged}.${sig}`, NOW), { ok: false, reason: "bad_signature" });
    assert.notEqual(forged, body);
    assert.deepEqual(verifyIdentityToken(secret, "nonsense", NOW), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyIdentityToken(secret, undefined, NOW), { ok: false, reason: "missing" });
    assert.deepEqual(verifyIdentityToken(secret, issueIdentityToken(secret, sub, "authenticated", NOW + 600_000), NOW), { ok: false, reason: "not_yet_valid" });
  });
  it("environmentFingerprint__is_deterministic_and_does_not_reveal_the_key", () => {
    assert.equal(environmentFingerprint("KEY1"), environmentFingerprint("KEY1"));
    assert.notEqual(environmentFingerprint("KEY1"), environmentFingerprint("KEY2"));
    assert.doesNotMatch(environmentFingerprint("KEY1"), /KEY1/);
  });
});

describe("cross-surface evaluation", () => {
  it("evaluate__same_subject_correct_on_all_four_surfaces__is_valid", () => {
    const r = evalAt([...observe(SUBJECT, "upi_first"), ...observe("sub_" + "b".repeat(32), "control")]);
    assert.equal(r.status, "CONTRACT_VALID", JSON.stringify(r.findings.map((f) => f.message)));
    assert.ok(r.surfaces.every((s) => s.status === "compliant"));
    assert.equal(r.subjects.length, 2);
  });

  it("evaluate__no_observations__is_no_data_not_valid", () => {
    assert.equal(evalAt([]).status, "NO_DATA");
  });

  it("evaluate__payment_api_legacy_and_risk_incompatible__is_combination_violation", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "payment-api": { features: { payment_route: "legacy" } }, "risk-engine": { features: { retry_policy: "standard" } } }));
    assert.equal(r.status, "CONTRACT_VIOLATION");
    assert.equal(r.primaryCode, "COMBINATION_VIOLATION");
    const bySurface = Object.fromEntries(r.surfaces.map((s) => [s.id, s.status]));
    assert.deepEqual([bySurface["web-checkout"], bySurface["payment-api"], bySurface["risk-engine"]], ["compliant", "violating", "violating"]);
    assert.ok(r.findings.some((f) => f.surfaceId === "payment-api" && f.expected === "upi_intent_v2" && f.actual === "legacy"));
  });

  it("evaluate__one_surface_reports_another_variant__is_assignment_mismatch", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "mobile-checkout": { assignedVariant: "control", features: { checkout_ui: "classic" } } }));
    assert.equal(r.primaryCode, "ASSIGNMENT_MISMATCH");
    assert.match(r.findings.find((f) => f.code === "ASSIGNMENT_MISMATCH")!.actual, /mobile-checkout=control/);
  });

  it("evaluate__surface_disagrees_with_flagsmith_canonical__is_assignment_mismatch", () => {
    const r = evalAt(observe(SUBJECT, "upi_first"), exampleContract(), NOW, new Map([[SUBJECT, "control"]]));
    assert.ok(r.findings.some((f) => f.code === "ASSIGNMENT_MISMATCH" && /Flagsmith currently assigns "control"/.test(f.message)));
  });

  it("evaluate__missing_assignment_on_a_surface__is_reported", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "risk-engine": { assignedVariant: null } }));
    assert.ok(r.findings.some((f) => f.code === "ASSIGNMENT_MISSING" && f.surfaceId === "risk-engine"));
  });

  it("evaluate__different_environment__is_environment_mismatch", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "payment-api": { environment: "staging" } }));
    assert.equal(r.primaryCode, "ENVIRONMENT_MISMATCH");
    assert.match(r.findings[0]!.message, /buckets environments independently/);
  });

  it("evaluate__surfaces_use_different_flagsmith_environment_keys__is_environment_mismatch", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "risk-engine": { envFingerprint: "bbbbbbbbbbbbbbbb" } }));
    assert.ok(r.findings.some((f) => f.code === "ENVIRONMENT_MISMATCH" && f.surfaceId === null));
  });

  it("evaluate__pinned_environment_fingerprint__flags_other_environments", () => {
    const c = exampleContract((raw) => { raw.experiment.environment_fingerprint = "cccccccccccccccc"; });
    assert.ok(evalAt(observe(SUBJECT, "upi_first"), c).findings.some((f) => f.code === "ENVIRONMENT_MISMATCH"));
  });

  it("evaluate__unlinked_identity__is_reported_and_never_guessed_into_a_subject", () => {
    const obs = observe(SUBJECT, "upi_first").map((o) => o.surfaceId === "web-checkout" ? { ...o, subjectRef: null, identityStatus: "unlinked" as const, identityReason: "bad_signature" } : o);
    const r = evalAt(obs);
    const f = r.findings.find((x) => x.code === "IDENTITY_UNLINKED")!;
    assert.equal(f.surfaceId, "web-checkout");
    assert.equal(r.unlinkedObservations, 1);
    assert.equal(r.subjects[0]!.cells.find((c) => c.surfaceId === "web-checkout")!.state === "missing" || r.subjects[0]!.cells.find((c) => c.surfaceId === "web-checkout")!.state === "delayed", true);
  });

  it("evaluate__same_identity_across_surfaces__is_one_subject_row", () => {
    const r = evalAt(observe(SUBJECT, "upi_first"));
    assert.equal(r.subjects.length, 1);
    assert.equal(r.subjects[0]!.cells.length, 4);
  });

  it("evaluate__required_surface_silent_within_grace__is_delayed_info_not_a_finding_of_failure", () => {
    const r = evalAt(observe(SUBJECT, "upi_first").filter((o) => o.surfaceId !== "risk-engine"), exampleContract(), NOW - 30_000 + 60_000);
    const f = r.findings.find((x) => x.code === "MISSING_SURFACE")!;
    assert.equal(f.severity, "info");
    assert.match(f.message, /may simply be delayed/);
    assert.equal(r.status, "CONTRACT_VALID");
  });

  it("evaluate__required_surface_silent_past_grace__is_incomplete_not_violation", () => {
    const r = evalAt(observe(SUBJECT, "upi_first").filter((o) => o.surfaceId !== "risk-engine"), exampleContract(), NOW + 600_000);
    const f = r.findings.find((x) => x.code === "MISSING_SURFACE")!;
    assert.equal(f.severity, "warning");
    assert.match(f.message, /does not establish that the surface failed/);
    assert.equal(r.status, "CONTRACT_INCOMPLETE");
  });

  it("evaluate__optional_surface_silent__is_not_a_finding", () => {
    const c = exampleContract((raw) => { raw.surfaces.find((s: any) => s.id === "mobile-checkout").required = false; });
    const r = evalAt(observe(SUBJECT, "upi_first").filter((o) => o.surfaceId !== "mobile-checkout"), c, NOW + 600_000);
    assert.ok(!r.findings.some((f) => f.code === "MISSING_SURFACE"));
  });

  it("evaluate__old_observation__is_stale_and_distinct_from_wrong", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", {}, NOW - 1_800_000), exampleContract(), NOW);
    assert.ok(r.findings.some((f) => f.code === "STALE_OBSERVATION" && /outdated rather than wrong/.test(f.message)));
    assert.equal(r.status, "CONTRACT_INCOMPLETE");
  });

  it("evaluate__observation_outside_correlation_window__is_ignored", () => {
    assert.equal(evalAt(observe(SUBJECT, "upi_first", {}, NOW - 7_200_000)).status, "NO_DATA");
  });

  it("evaluate__observation_for_older_contract_version__is_a_version_mismatch_warning", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "web-checkout": { contractVersion: 0 } }));
    assert.ok(r.findings.some((f) => f.code === "CONTRACT_VERSION_MISMATCH" && f.surfaceId === "web-checkout"));
  });

  it("evaluate__variant_not_in_contract__is_unknown_variant", () => {
    const r = evalAt(observe(SUBJECT, "upi_first").map((o) => ({ ...o, assignedVariant: "blue" })));
    assert.ok(r.findings.some((f) => f.code === "UNKNOWN_VARIANT"));
  });

  it("evaluate__contradictory_values_for_one_feature__is_flagged", () => {
    const r = evalAt(observe(SUBJECT, "upi_first", { "mobile-checkout": { features: { checkout_ui: "classic" } } }));
    assert.ok(r.findings.some((f) => f.evidence.kind === "contradictory_state"));
  });

  it("evaluate__is_deterministic", () => {
    const o = observe(SUBJECT, "upi_first", { "payment-api": { features: { payment_route: "legacy" } } });
    assert.deepEqual(evalAt(o), evalAt(o));
  });
});

describe("contract drift", () => {
  const v1 = exampleContract();
  it("diffContracts__new_version_changes__are_listed_with_severity_and_surfaces", () => {
    const v2 = exampleContract((raw) => { raw.contract.version = 2; raw.variants.upi_first.payment_route = "upi_intent_v3"; raw.constraints[0].requires.payment_route = "upi_intent_v3"; raw.constraints[1].forbids.payment_route = "upi_intent_v3"; raw.experiment.environment = "staging"; });
    const d = diffContracts(v1, v2);
    const by = Object.fromEntries(d.map((x) => [x.attribute, x]));
    assert.equal(by["contract.version"]!.severity, "info");
    assert.equal(by["experiment.environment"]!.severity, "error");
    assert.equal(by["variant.upi_first.payment_route"]!.previous, "upi_intent_v2");
    assert.deepEqual(by["variant.upi_first.payment_route"]!.affectedSurfaces, ["payment-api"]);
    assert.ok(d.every((x) => x.evidence.previousVersion === 1 && x.evidence.currentVersion === 2));
  });
  it("diffContracts__identical__is_empty", () => {
    assert.deepEqual(diffContracts(v1, exampleContract()), []);
  });
  it("diffContracts__surface_removed_and_constraint_added__are_reported", () => {
    const v2 = exampleContract((raw) => { raw.contract.version = 2; raw.surfaces = raw.surfaces.filter((s: any) => s.id !== "mobile-checkout"); raw.constraints.push({ id: "extra", when: { retry_policy: "standard" }, forbids: { checkout_ui: "upi_first" } }); });
    const d = diffContracts(v1, v2).map((x) => x.attribute);
    assert.ok(d.includes("surface.mobile-checkout") && d.includes("constraint.extra"));
  });
  it("observationDrift__changed_feature_variant_and_environment__are_each_recorded", () => {
    const [a] = observe(SUBJECT, "upi_first", {}, NOW - 120_000);
    const [b] = observe(SUBJECT, "control", { "web-checkout": { environment: "staging", observationId: "n2", features: { checkout_ui: "classic" } } }, NOW);
    const d = observationDrift(a!, { ...b!, observationId: "n2" }).map((x) => x.attribute).sort();
    assert.deepEqual(d, ["assignment.variant", "environment", "feature.checkout_ui"]);
    assert.deepEqual(observationDrift(a!, { ...a!, observationId: "again" }), []);
  });
  it("silentSurfaces__stopped_reporting__is_drift_with_honest_wording", () => {
    const d = silentSurfaces(v1, new Set(["web-checkout", "payment-api"]), new Set(["web-checkout"]));
    assert.equal(d.length, 1);
    assert.equal(d[0]!.attribute, "surface.payment-api.reporting");
    assert.match(d[0]!.message, /cannot tell which/);
  });
  it("configDrift__weights_changed__warns_assignment_stability_may_be_affected", () => {
    assert.deepEqual(configDrift(v1, "abc", "abc", {}), []);
    assert.deepEqual(configDrift(v1, null, "abc", {}), []);
    const d = configDrift(v1, "abc", "def", { weights: [50, 50] });
    assert.match(d[0]!.message, /assignment stability may have been affected/);
  });
});
