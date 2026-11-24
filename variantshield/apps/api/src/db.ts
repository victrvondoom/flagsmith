import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore, StoredRow, TelemetryEvent } from "../../../packages/telemetry/src/index.ts";

const MIGRATIONS: string[] = [
  `CREATE TABLE plans (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     business_problem TEXT NOT NULL DEFAULT '',
     hypothesis TEXT NOT NULL DEFAULT '',
     control_variant TEXT NOT NULL DEFAULT 'control',
     treatment_variants TEXT NOT NULL DEFAULT '[]',
     primary_metric TEXT NOT NULL DEFAULT '',
     feature_key TEXT NOT NULL DEFAULT '',
     guardrail_overrides TEXT NOT NULL DEFAULT '{}',
     acceptance_criteria TEXT NOT NULL DEFAULT '[]',
     owner TEXT NOT NULL DEFAULT '',
     flagsmith_experiment_id INTEGER,
     last_flagsmith_status TEXT,
     last_synced_at INTEGER,
     approval_status TEXT NOT NULL DEFAULT 'pending',
     approval_by TEXT,
     approval_at INTEGER,
     approval_note TEXT,
     is_simulation INTEGER NOT NULL DEFAULT 0,
     sim_results TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE events (
     event_id TEXT PRIMARY KEY,
     payload_hash TEXT NOT NULL,
     type TEXT NOT NULL,
     experiment_id TEXT,
     feature_key TEXT NOT NULL,
     variant_key TEXT,
     attribution TEXT NOT NULL,
     identity_id TEXT NOT NULL,
     timestamp_ms INTEGER NOT NULL,
     request_id TEXT NOT NULL,
     operation TEXT NOT NULL,
     outcome TEXT NOT NULL,
     latency_ms REAL,
     error_category TEXT,
     http_status INTEGER,
     source TEXT NOT NULL
   );
   CREATE INDEX events_exp_ts ON events (experiment_id, source, timestamp_ms);
   CREATE INDEX events_ts ON events (timestamp_ms);
   CREATE TABLE bench_runs (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     target TEXT NOT NULL,
     fault TEXT,
     summary TEXT,
     log TEXT
   );
   CREATE TABLE bench_results (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
     variant TEXT NOT NULL,
     test_name TEXT NOT NULL,
     status TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     error TEXT,
     screenshot TEXT
   );
   CREATE TABLE evidence (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     payload TEXT NOT NULL
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     plan_id INTEGER,
     flagsmith_experiment_id INTEGER,
     dry_run INTEGER NOT NULL,
     simulated INTEGER NOT NULL DEFAULT 0,
     outcome TEXT NOT NULL,
     reason TEXT,
     evidence_id INTEGER,
     before_state TEXT,
     after_state TEXT,
     detail TEXT
   );`,
  // 2: cross-surface experiment contracts. Contract versions are immutable; findings and drift are historical.
  `CREATE TABLE contracts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     contract_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     manifest TEXT NOT NULL,
     manifest_hash TEXT NOT NULL,
     is_simulation INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     UNIQUE (contract_id, version)
   );
   CREATE TABLE contract_observations (
     observation_id TEXT PRIMARY KEY,
     payload_hash TEXT NOT NULL,
     contract_id TEXT NOT NULL,
     contract_version INTEGER NOT NULL,
     experiment_key TEXT NOT NULL,
     environment TEXT NOT NULL,
     env_fingerprint TEXT,
     assignment_flag TEXT NOT NULL,
     assigned_variant TEXT,
     surface_id TEXT NOT NULL,
     subject_ref TEXT,
     identity_status TEXT NOT NULL,
     identity_reason TEXT,
     observed_at INTEGER NOT NULL,
     received_at INTEGER NOT NULL,
     features TEXT NOT NULL,
     source TEXT NOT NULL
   );
   CREATE INDEX cobs_contract_ts ON contract_observations (contract_id, source, observed_at);
   CREATE INDEX cobs_subject ON contract_observations (contract_id, subject_ref, surface_id, observed_at);
   CREATE TABLE contract_findings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dedupe_key TEXT NOT NULL UNIQUE,
     contract_id TEXT NOT NULL,
     contract_version INTEGER NOT NULL,
     code TEXT NOT NULL,
     severity TEXT NOT NULL,
     surface_id TEXT,
     subject_ref TEXT,
     observed_at INTEGER,
     detected_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     expected TEXT NOT NULL,
     actual TEXT NOT NULL,
     message TEXT NOT NULL,
     evidence TEXT NOT NULL,
     source TEXT NOT NULL
   );
   CREATE INDEX cfind_contract ON contract_findings (contract_id, contract_version, detected_at);
   CREATE TABLE contract_drift (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dedupe_key TEXT NOT NULL UNIQUE,
     contract_id TEXT NOT NULL,
     previous_version INTEGER,
     current_version INTEGER NOT NULL,
     attribute TEXT NOT NULL,
     previous_value TEXT,
     current_value TEXT,
     severity TEXT NOT NULL,
     affected_surfaces TEXT NOT NULL,
     message TEXT NOT NULL,
     evidence TEXT NOT NULL,
     detected_at INTEGER NOT NULL,
     source TEXT NOT NULL
   );
   CREATE INDEX cdrift_contract ON contract_drift (contract_id, detected_at);
   CREATE TABLE assignment_config_snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     contract_id TEXT NOT NULL,
     taken_at INTEGER NOT NULL,
     fingerprint TEXT NOT NULL,
     config TEXT NOT NULL
   );
   CREATE INDEX csnap_contract ON assignment_config_snapshots (contract_id, taken_at);`,
  // 3: decision ledger. Append-only, hash-chained and HMAC-signed; triggers refuse UPDATE and DELETE.
  `CREATE TABLE ledger_entries (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     entry_id TEXT NOT NULL UNIQUE,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     subject_type TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     actor TEXT NOT NULL,
     summary TEXT NOT NULL,
     payload TEXT NOT NULL,
     ref_seq INTEGER,
     source TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL UNIQUE,
     signature TEXT NOT NULL
   );
   CREATE INDEX ledger_subject ON ledger_entries (subject_type, subject_id, seq);
   CREATE INDEX ledger_kind ON ledger_entries (kind, seq);
   CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
   CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;`,
];
export type Row = Record<string, unknown>;

export class Db implements EventStore {
  readonly raw: DatabaseSync;
  /** Identifies this database instance (used to scope in-process caches). */
  readonly id = randomUUID();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = new Set((this.raw.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version));
    MIGRATIONS.forEach((sql, i) => {
      if (done.has(i + 1)) return;
      this.tx(() => {
        this.raw.exec(sql);
        this.raw.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(i + 1, Date.now());
      });
    });
  }

  private txDepth = 0;

  /** Runs `fn` in one transaction. Re-entrant: a nested call joins the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }

  run(sql: string, ...params: (string | number | null)[]): { lastInsertRowid: number; changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  insertIfAbsent(row: StoredRow): "inserted" | { existingHash: string } {
    const e = row.event;
    const res = this.raw.prepare(
      `INSERT OR IGNORE INTO events (event_id, payload_hash, type, experiment_id, feature_key, variant_key, attribution, identity_id,
         timestamp_ms, request_id, operation, outcome, latency_ms, error_category, http_status, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.eventId, row.payloadHash, e.type, e.experimentId, e.featureKey, e.variantKey, e.attribution, e.identityId, e.timestampMs,
      e.requestId, e.operation, e.outcome, e.latencyMs, e.errorCategory, e.httpStatus, e.source);
    if (Number(res.changes) === 1) return "inserted";
    const existing = this.get("SELECT payload_hash FROM events WHERE event_id = ?", e.eventId);
    return { existingHash: String(existing?.payload_hash) };
  }

  purgeEventsOlderThan(cutoffMs: number): number {
    return this.run("DELETE FROM events WHERE timestamp_ms < ?", cutoffMs).changes;
  }

  /**
   * Retention for contract data. Observations (high volume) use the event retention; findings, drift and configuration
   * snapshots are history and live much longer. Returns the number of rows removed per table.
   */
  purgeContractData(observationCutoffMs: number, historyCutoffMs: number): Record<string, number> {
    return this.tx(() => ({
      contract_observations: this.run("DELETE FROM contract_observations WHERE observed_at < ?", observationCutoffMs).changes,
      contract_findings: this.run("DELETE FROM contract_findings WHERE last_seen_at < ?", historyCutoffMs).changes,
      contract_drift: this.run("DELETE FROM contract_drift WHERE detected_at < ?", historyCutoffMs).changes,
      assignment_config_snapshots: this.run("DELETE FROM assignment_config_snapshots WHERE taken_at < ?", historyCutoffMs).changes,
    }));
  }

  close(): void {
    this.raw.close();
  }
}

export type { TelemetryEvent };
