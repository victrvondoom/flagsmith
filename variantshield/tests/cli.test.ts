import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../apps/api/src/config.ts";
import { Db } from "../apps/api/src/db.ts";
import { createApp, type App } from "../apps/api/src/app.ts";

process.env.VARIANTSHIELD_LOG = "off";
const ADMIN = "cli-admin-token-0123456789";
const CLI = resolve(import.meta.dirname, "../apps/cli/src/main.ts");
const EXAMPLE = resolve(import.meta.dirname, "../examples/checkout-journey.contract.yaml");
let app: App, url: string, dir: string;

const run = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((res) => execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", VARIANTSHIELD_URL: url, VARIANTSHIELD_ADMIN_TOKEN: ADMIN, ...env } }, (err, stdout, stderr) => res({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr })));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "vs-cli-"));
  const cfg = loadConfig({ VARIANTSHIELD_ADMIN_TOKEN: ADMIN, VARIANTSHIELD_INGEST_KEY: "cli-ingest-key-0123456789", VARIANTSHIELD_DB_PATH: ":memory:", PORT: "0" });
  app = createApp({ cfg, db: new Db(":memory:"), now: () => Date.now(), flagsmith: null });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((r) => app.server.close(() => r())); app.ctx.db.close(); });

describe("variantshield CLI", () => {
  it("validate__example_manifest__exits_0_and_json_is_machine_readable", async () => {
    const r = await run(["contract", "validate", "--file", EXAMPLE, "--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.valid, true);
    assert.deepEqual(j.contract.surfaces.map((s: any) => s.id), ["web-checkout", "mobile-checkout", "payment-api", "risk-engine"]);
  });

  it("validate__human_output_lists_referenced_surfaces_and_features", async () => {
    const r = await run(["contract", "validate", "--file", EXAMPLE]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Surfaces \(4\): web-checkout/);
    assert.match(r.stdout, /Features: checkout_ui, payment_route, retry_policy/);
  });

  it("validate__missing_fields__exits_1_with_every_issue_and_its_path", async () => {
    const f = join(dir, "bad.yaml"); writeFileSync(f, "contract:\n  id: x\nsurfaces: []\n");
    const r = await run(["contract", "validate", "--file", f, "--json"]);
    assert.equal(r.code, 1);
    const paths = JSON.parse(r.stdout).issues.map((i: any) => i.path);
    for (const p of ["contract.version", "experiment", "surfaces", "variants"]) assert.ok(paths.includes(p), p);
  });

  it("validate__contradictory_rules__exits_1", async () => {
    const f = join(dir, "contradiction.yaml");
    writeFileSync(f, readFileSync(EXAMPLE, "utf8").replace("classic-never-uses-upi-route", "conflict").replace("when:\n      checkout_ui: classic\n    forbids:\n      payment_route: upi_intent_v2", "when:\n      checkout_ui: upi_first\n    requires:\n      payment_route: legacy"));
    const r = await run(["contract", "validate", "--file", f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /require different values|violates constraint/);
  });

  it("validate__broken_yaml__exits_1_and_points_at_the_line", async () => {
    const f = join(dir, "broken.yaml"); writeFileSync(f, "contract:\n  id: x\n   version: 1\n");
    const r = await run(["contract", "validate", "--file", f]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /line \d+/);
  });

  it("usage__unknown_command_missing_file_and_unreadable_file__exit_2", async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(["contract", "frobnicate"])).code, 2);
    assert.equal((await run(["contract", "validate"])).code, 2);
    assert.equal((await run(["contract", "validate", "--file", join(dir, "nope.yaml")])).code, 2);
    assert.equal((await run(["contract", "check"])).code, 2);
  });

  it("env_fingerprint__prints_a_stable_non_secret_value", async () => {
    const a = await run(["env-fingerprint", "SOMEKEY"]), b = await run(["env-fingerprint", "SOMEKEY"]);
    assert.equal(a.stdout, b.stdout);
    assert.match(a.stdout.trim(), /^[a-f0-9]{16}$/);
  });

  it("check__without_token_or_with_a_wrong_token__exits_2_and_never_prints_the_token", async () => {
    assert.equal((await run(["contract", "check", "--contract", "x"], { VARIANTSHIELD_ADMIN_TOKEN: "" })).code, 2);
    const wrong = await run(["contract", "check", "--contract", "x"], { VARIANTSHIELD_ADMIN_TOKEN: "definitely-wrong-token-value" });
    assert.equal(wrong.code, 2);
    assert.doesNotMatch(wrong.stdout + wrong.stderr, /definitely-wrong-token-value/);
  });

  it("check__unreachable_server__exits_2", async () => {
    const r = await run(["contract", "check", "--contract", "x"], { VARIANTSHIELD_URL: "http://127.0.0.1:1" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Cannot reach VariantShield/);
  });

  it("register_then_check__a_real_workflow_through_the_api__nodata_exits_3_unless_allowed", async () => {
    const reg = await run(["contract", "register", "--file", EXAMPLE, "--json"]);
    assert.equal(reg.code, 0, reg.stderr);
    assert.equal(JSON.parse(reg.stdout).status, "created");
    assert.match((await run(["contract", "register", "--file", EXAMPLE])).stdout, /Already registered/);
    const c = await run(["contract", "check", "--contract", "checkout-journey", "--json"]);
    assert.equal(c.code, 3);
    assert.equal(JSON.parse(c.stdout).report.status, "NO_DATA");
    assert.equal((await run(["contract", "check", "--contract", "checkout-journey", "--allow-incomplete"])).code, 0);
  });

  it("check__simulated_scenarios__exit_codes_gate_ci_and_json_carries_findings", async () => {
    const sim = (id: string) => fetch(`${url}/api/simulate/contract/${id}`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    await sim("invalid-combination");
    const bad = await run(["contract", "check", "--contract", "sim-checkout-journey", "--json"]);
    assert.equal(bad.code, 1);
    const j = JSON.parse(bad.stdout);
    assert.equal(j.report.primaryCode, "COMBINATION_VIOLATION");
    assert.equal(j.source, "simulation");
    assert.ok(j.report.findings.some((f: any) => f.surfaceId === "payment-api" && f.actual === "legacy"));
    await sim("valid");
    const ok = await run(["contract", "check", "--contract", "sim-checkout-journey"]);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /CONTRACT_VALID.*\[SIMULATION\]/);
  });

  it("report__is_read_only_and_matches_check_status", async () => {
    await fetch(`${url}/api/simulate/contract/assignment-mismatch`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    const before = app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_findings")?.n;
    const r = await run(["contract", "report", "--contract", "sim-checkout-journey", "--json"]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).report.primaryCode, "ASSIGNMENT_MISMATCH");
    assert.equal(app.ctx.db.get("SELECT COUNT(*) AS n FROM contract_findings")?.n, before);
  });

  it("ledger__verify_online_export_and_offline_verification_detect_tampering_and_head_mismatch", async () => {
    // Given a ledger with entries (a simulated plan and two notes)
    const H = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    const sim = await (await fetch(`${url}/api/simulate/safe-winner`, { method: "POST", headers: H })).json() as { plan: { id: number } };
    for (const t of ["first note", "second note", "third note"]) await fetch(`${url}/api/ledger/notes`, { method: "POST", headers: H, body: JSON.stringify({ scope: { type: "plan", id: String(sim.plan.id) }, text: t }) });
    // When verified online and exported
    const online = await run(["ledger", "verify", "--json"]);
    assert.equal(online.code, 0);
    assert.equal(JSON.parse(online.stdout).signaturesChecked, true);
    const out = join(dir, "ledger.json");
    assert.equal((await run(["ledger", "export", "--out", out])).code, 0);
    const exported = JSON.parse(readFileSync(out, "utf8"));
    // Then it verifies offline, and the head can be pinned
    assert.equal((await run(["ledger", "verify", "--file", out])).code, 0);
    assert.equal((await run(["ledger", "verify", "--file", out, "--expect-head", exported.head])).code, 0);
    const wrongHead = await run(["ledger", "verify", "--file", out, "--expect-head", "0".repeat(64)]);
    assert.equal(wrongHead.code, 1);
    assert.match(wrongHead.stdout, /does not match the expected head/);
    // An edited entry and a removed entry are both caught offline
    const edited = structuredClone(exported); edited.entries[1].summary = "edited"; writeFileSync(join(dir, "edited.json"), JSON.stringify(edited));
    const e = await run(["ledger", "verify", "--file", join(dir, "edited.json")]);
    assert.equal(e.code, 1); assert.match(e.stdout, /does not match its hash/);
    const removed = structuredClone(exported); removed.entries.splice(1, 1); writeFileSync(join(dir, "removed.json"), JSON.stringify(removed));
    const r = await run(["ledger", "verify", "--file", join(dir, "removed.json"), "--json"]);
    assert.equal(r.code, 1); assert.equal(JSON.parse(r.stdout).ok, false);
    assert.equal((await run(["ledger", "verify", "--file", join(dir, "nope.json")])).code, 2);
  });
});
