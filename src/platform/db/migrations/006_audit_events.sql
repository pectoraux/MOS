-- MKT-005 Audit event schema (AUD-001, issue #13 MKT-005-AC-06).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   audit_events → /audit (Audit trail)
--
-- Frozen semantics encoded here (spec/implementation-contract.md §22
-- "Audit contract"):
--   * APPEND-ONLY: rows can NEVER be updated or deleted through ANY SQL
--     path — a BEFORE UPDATE OR DELETE trigger rejects the statement. The
--     audit trail is immutable history, not mutable state;
--   * SERVER-OWNED: event identity (event_id) and occurrence time are
--     server-generated; actor, scope, action, target and correlation are
--     derived by server code from the authenticated principal, canonical
--     owner scope and ambient correlation context — NEVER from request
--     bodies (there is no public mutation path to this table at all);
--   * CORRELATION-LINKED: every event carries the correlation id of the
--     logical flow (sync API request or async worker execution) and the
--     causation id (the job id for worker-caused events);
--   * idempotency_key is a PARTIAL unique fence: a replayed emission of the
--     same logical event converges to the existing row (no duplicate
--     logical audit records) while still allowing genuinely distinct
--     events without a key;
--   * before/after versions capture CAS transitions where applicable;
--   * details is JSONB metadata WITHOUT secret material — the module-level
--     guard rejects material-like keys before insert (§21 backstop).
--
-- The table intentionally has no version/updated_at columns: rows are
-- written exactly once and never mutated (concurrency = insert races only,
-- resolved by the primary key and the idempotency fence).

CREATE TABLE IF NOT EXISTS audit_events (
    event_id        uuid        PRIMARY KEY,
    occurred_at     timestamptz NOT NULL,
    actor           text        NOT NULL,
    action          text        NOT NULL,
    agency_id       uuid,
    client_id       uuid,
    workspace_id    uuid,
    target_type     text        NOT NULL,
    target_id       text        NOT NULL,
    correlation_id  text        NOT NULL,
    causation_id    text,
    idempotency_key text,
    before_version  bigint,
    after_version   bigint,
    result          text        NOT NULL CHECK (result IN ('succeeded', 'failed')),
    details         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    recorded_at     timestamptz NOT NULL DEFAULT now()
);

-- Replay fence: the same logical event (same idempotency key) can never be
-- recorded twice. Events that may legitimately repeat (e.g. failed login
-- attempts) are emitted WITHOUT a key.
CREATE UNIQUE INDEX IF NOT EXISTS audit_events_idempotency_fence
    ON audit_events (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events (correlation_id);
CREATE INDEX IF NOT EXISTS audit_events_scope_idx ON audit_events (agency_id, client_id, workspace_id);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_type, target_id);

-- APPEND-ONLY backstop (issue #13 MKT-005-AC-06: "material records cannot
-- be fabricated or rewritten"): the database itself rejects UPDATE and
-- DELETE on the audit trail. Not even server code can rewrite history.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is rejected on event %',
        TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only_update_trigger ON audit_events;
CREATE TRIGGER audit_events_append_only_update_trigger
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

DROP TRIGGER IF EXISTS audit_events_append_only_delete_trigger ON audit_events;
CREATE TRIGGER audit_events_append_only_delete_trigger
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
