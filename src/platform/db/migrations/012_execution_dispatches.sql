-- MKT-011 Pooled worker execution schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map: "Execution
-- identity/lifecycle belongs only to /executions" (AGENTS.md) — this table
-- does NOT mutate or describe execution lifecycle. It is the pooled
-- runtime's TRANSACTIONAL OUTBOX (work-items.md MKT-011: "execute normal
-- tasks through shared workers with durable queues and idempotency";
-- requirements.md RUNTIME-001 "pooled worker execution";
-- architecture.md §14 "The default runtime uses pooled workers" and
-- "Workflow → Task → Execution → Runtime Class → Worker or Sandbox Lease"):
-- the durable record that an Execution identity was HANDED to the pooled
-- worker path, written by the dispatch command and drained by the relay
-- into the platform durable queue (platform_jobs). Job/queue state remains
-- platform execution plumbing (the queue contract: "The queue is
-- infrastructure, never a business authority"); execution state remains the
-- /executions authority, driven exclusively through its single transition
-- port.
--
-- Frozen semantics encoded here:
--
--   * ONE durable dispatch per Execution identity — UNIQUE (execution_id).
--     A duplicate dispatch command converges to the recorded row (same
--     command fingerprint), a key reused for a different command is a
--     conflict (spec/implementation-contract.md §8: the DATABASE, not
--     application check-then-insert, is the duplicate fence — EXEC-AC-03
--     "retry does not create duplicate logical execution effects");
--   * the dispatch identity tuple (execution, task kind, input snapshot,
--     input reference, idempotency key, fingerprint, correlation identity,
--     provenance) is IMMUTABLE after recording;
--   * the dispatch lifecycle is exactly recorded → submitted (the relay's
--     single forward edge), with ONE deliberately narrow re-arm edge
--     submitted → recorded that requires outcome = 'deferred-paused' AND
--     cycle + 1 — a tenant-paused pooled execution, once resumed, is
--     re-driven through a FRESH queue job (new cycle, new queue idempotency
--     key); nothing else may move backwards;
--   * the outcome columns (outcome, output_ref, output, outcome_reason)
--     are SET-ONCE evidence of the pooled run's verdict. The only legal
--     re-record overwrites a 'deferred-paused' placeholder with the final
--     verdict of a later cycle;
--   * job_id is bound when the relay submits and may only move forward
--     together with a recorded → submitted transition;
--   * version is the CAS token for relay/sweep concurrency.
--
-- This is deliberately NOT a second execution authority: nothing here can
-- change an execution's status, history or leases. The worker drives the
-- /executions transition port like any other authorized caller.

CREATE TABLE IF NOT EXISTS execution_dispatches (
    dispatch_id          uuid        PRIMARY KEY,
    -- UNIQUE: one durable dispatch per Execution identity.
    execution_id         uuid        NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
    -- The registered pooled task-runner kind (validated against the
    -- registry at dispatch time; extensible — later work items register
    -- AI/integration runner kinds without schema changes).
    task_kind            text        NOT NULL
                         CHECK (task_kind ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND length(task_kind) <= 100),
    -- The dispatch-time input snapshot (bounded JSON) and an optional
    -- opaque large-input reference (object-store key).
    input                jsonb       NOT NULL DEFAULT '{}'::jsonb,
    input_ref            text        CHECK (input_ref IS NULL OR (length(input_ref) >= 1 AND length(input_ref) <= 512)),
    -- The pooled job plumbing coordinates (immutable after record).
    queue_name           text        NOT NULL DEFAULT 'executions.pooled'
                         CHECK (length(queue_name) >= 1 AND length(queue_name) <= 100),
    handler_kind         text        NOT NULL DEFAULT 'executions.pooled.run'
                         CHECK (length(handler_kind) >= 1 AND length(handler_kind) <= 100),
    max_attempts         int         NOT NULL DEFAULT 5 CHECK (max_attempts >= 1 AND max_attempts <= 25),
    -- The dispatch lifecycle: 'recorded' (outbox row awaiting the relay) →
    -- 'submitted' (durable job exists). The ONLY backward edge is the
    -- cycle-incrementing re-arm of a deferred-paused dispatch.
    dispatch_status      text        NOT NULL DEFAULT 'recorded'
                         CHECK (dispatch_status IN ('recorded', 'submitted')),
    -- The queue job this dispatch currently resolves to (bound by the
    -- relay at submit time; moves forward only with recorded → submitted).
    job_id               text        CHECK (job_id IS NULL OR (length(job_id) >= 1 AND length(job_id) <= 100)),
    -- Re-drive cycle: 1 for the initial dispatch; incremented ONLY by the
    -- deferred-paused re-arm (each cycle submits a FRESH queue job under a
    -- cycle-scoped queue idempotency key).
    cycle                int         NOT NULL DEFAULT 1 CHECK (cycle >= 1),
    -- SET-ONCE run verdict: 'succeeded' | 'failed' | 'unknown' |
    -- 'deferred-paused' (the placeholder a resumed execution overwrites).
    outcome              text        CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'unknown', 'deferred-paused')),
    output_ref           text        CHECK (output_ref IS NULL OR (length(output_ref) >= 1 AND length(output_ref) <= 512)),
    output               jsonb,
    outcome_reason       text        NOT NULL DEFAULT '',
    -- The §8 LOGICAL dispatch command key and its fingerprint (a duplicate
    -- of the same command converges; a key reused for a different command
    -- is a conflict).
    idempotency_key      text        NOT NULL CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint   text        NOT NULL CHECK (length(create_fingerprint) = 64),
    -- Correlation identity captured at dispatch time (OBS-AC-01: it must
    -- cross the worker boundary through durable state, not memory).
    correlation_id       text        NOT NULL CHECK (length(correlation_id) >= 1 AND length(correlation_id) <= 100),
    causation_id         text        CHECK (causation_id IS NULL OR (length(causation_id) >= 1 AND length(causation_id) <= 100)),
    created_by           uuid        REFERENCES users(user_id),
    version              bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    -- The per-execution dispatch fence: exactly ONE dispatch row per
    -- Execution identity, enforced by the database.
    CONSTRAINT execution_dispatches_execution_unique UNIQUE (execution_id)
);

-- Relay scan: pending outbox rows, oldest first.
CREATE INDEX IF NOT EXISTS execution_dispatches_recorded_idx
    ON execution_dispatches (created_at, dispatch_id) WHERE dispatch_status = 'recorded';
-- Sweep scan: submitted dispatches joined against their queue jobs.
CREATE INDEX IF NOT EXISTS execution_dispatches_submitted_idx
    ON execution_dispatches (dispatch_status, cycle, dispatch_id) WHERE dispatch_status = 'submitted';

-- Immutability backstop: the dispatch identity tuple can NEVER be
-- reassigned through ANY mutation path. Only the lifecycle columns
-- (dispatch_status, job_id, cycle), the set-once outcome columns, the CAS
-- version and updated_at may change.
CREATE OR REPLACE FUNCTION execution_dispatches_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.dispatch_id <> OLD.dispatch_id THEN
        RAISE EXCEPTION 'dispatch_id is immutable';
    END IF;
    IF NEW.execution_id <> OLD.execution_id THEN
        RAISE EXCEPTION 'execution_dispatches.execution_id is immutable (one dispatch per execution identity)';
    END IF;
    IF NEW.task_kind <> OLD.task_kind
       OR NEW.input <> OLD.input
       OR NEW.input_ref IS DISTINCT FROM OLD.input_ref
       OR NEW.queue_name <> OLD.queue_name
       OR NEW.handler_kind <> OLD.handler_kind
       OR NEW.max_attempts <> OLD.max_attempts THEN
        RAISE EXCEPTION 'the dispatch command (task kind, input, queue coordinates, attempt policy) is immutable';
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.create_fingerprint <> OLD.create_fingerprint
       OR NEW.correlation_id <> OLD.correlation_id
       OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'the dispatch provenance (idempotency key, fingerprint, correlation, creator) is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_dispatches_identity_immutable_trigger ON execution_dispatches;
CREATE TRIGGER execution_dispatches_identity_immutable_trigger
    BEFORE UPDATE ON execution_dispatches
    FOR EACH ROW EXECUTE FUNCTION execution_dispatches_identity_immutable();

-- Lifecycle backstop: exactly two forward edges and one narrow re-arm.
--   recorded → submitted : the relay binds a queue job (job_id may be set).
--   submitted → recorded : ONLY the deferred-paused re-arm, and ONLY with
--                          cycle + 1 (a fresh queue job follows; outcome
--                          resets are governed by the outcome trigger).
-- Same-status updates (outcome recording, CAS version bumps) carry no
-- lifecycle change and pass through; any OTHER status change is rejected —
-- even under direct SQL.
CREATE OR REPLACE FUNCTION execution_dispatches_lifecycle() RETURNS trigger AS $$
BEGIN
    IF OLD.dispatch_status = NEW.dispatch_status THEN
        RETURN NEW; -- bookkeeping only (outcome evidence, version CAS)
    END IF;

    IF OLD.dispatch_status = 'recorded' AND NEW.dispatch_status = 'submitted' THEN
        IF NEW.cycle <> OLD.cycle THEN
            RAISE EXCEPTION 'submitting a dispatch cannot change its cycle';
        END IF;
        IF NEW.job_id IS NULL THEN
            RAISE EXCEPTION 'a submitted dispatch must be bound to its queue job';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.dispatch_status = 'submitted' AND NEW.dispatch_status = 'recorded' THEN
        IF OLD.outcome IS DISTINCT FROM 'deferred-paused' THEN
            RAISE EXCEPTION 'only a deferred-paused dispatch may be re-armed (outcome is %)', COALESCE(OLD.outcome, 'unset');
        END IF;
        IF NEW.cycle <> OLD.cycle + 1 THEN
            RAISE EXCEPTION 're-arming a dispatch increments its cycle exactly once';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'illegal dispatch lifecycle change % → % (recorded → submitted is the only forward edge; submitted → recorded only re-arms a deferred-paused dispatch)',
        OLD.dispatch_status, NEW.dispatch_status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_dispatches_lifecycle_trigger ON execution_dispatches;
CREATE TRIGGER execution_dispatches_lifecycle_trigger
    BEFORE UPDATE ON execution_dispatches
    FOR EACH ROW EXECUTE FUNCTION execution_dispatches_lifecycle();

-- Set-once outcome backstop: the run verdict is evidence, not a mutable
-- field. NULL → value exactly once; the ONLY legal re-record overwrites a
-- 'deferred-paused' placeholder (the final verdict of a re-driven cycle).
CREATE OR REPLACE FUNCTION execution_dispatches_outcome_set_once() RETURNS trigger AS $$
BEGIN
    IF OLD.outcome IS NULL THEN
        IF NEW.outcome IS NULL AND NEW.output_ref IS NULL AND NEW.output IS NULL
           AND NEW.outcome_reason = OLD.outcome_reason THEN
            RETURN NEW; -- no outcome change at all
        END IF;
        IF NEW.outcome IS NULL THEN
            RAISE EXCEPTION 'recording a dispatch outcome requires its verdict';
        END IF;
        RETURN NEW;
    END IF;

    -- An outcome was already recorded.
    IF NEW.outcome IS DISTINCT FROM OLD.outcome
       OR NEW.output_ref IS DISTINCT FROM OLD.output_ref
       OR NEW.output IS DISTINCT FROM OLD.output
       OR NEW.outcome_reason <> OLD.outcome_reason THEN
        IF OLD.outcome = 'deferred-paused' THEN
            IF NEW.outcome IS NULL THEN
                RAISE EXCEPTION 'the final verdict replacing a deferred-paused placeholder cannot be null';
            END IF;
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'the dispatch outcome is set-once evidence (verdict % is final)', OLD.outcome;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_dispatches_outcome_set_once_trigger ON execution_dispatches;
CREATE TRIGGER execution_dispatches_outcome_set_once_trigger
    BEFORE UPDATE ON execution_dispatches
    FOR EACH ROW EXECUTE FUNCTION execution_dispatches_outcome_set_once();
