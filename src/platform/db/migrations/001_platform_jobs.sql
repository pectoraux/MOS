-- MKT-001 platform foundation schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- platform_jobs / platform_job_attempts implement the durable background-work
-- conventions required by MKT-001:
--   * durable job identity with an idempotency fence backed by a UNIQUE
--     partial index (spec/implementation-contract.md §8 — application-level
--     check-then-insert is never the sole duplicate fence);
--   * append-oriented attempt history (no row is ever rewritten historically);
--   * state constraints as database backstops;
--   * correlation identity persisted on every job and attempt row so it
--     survives the worker process boundary (OBS-AC-01).

CREATE TABLE IF NOT EXISTS platform_jobs (
    job_id           uuid        PRIMARY KEY,
    queue            text        NOT NULL DEFAULT 'platform.default',
    handler_kind     text        NOT NULL,
    payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key  text,
    status           text        NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
    attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts     integer     NOT NULL CHECK (max_attempts >= 1),
    run_after        timestamptz NOT NULL DEFAULT now(),
    claimed_by       text,
    claimed_at       timestamptz,
    correlation_id   text        NOT NULL,
    causation_id     text,
    submitted_by     text        NOT NULL,
    result           jsonb,
    error            jsonb,
    version          bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Idempotency fence: one logical job per (queue, handler, idempotency key).
CREATE UNIQUE INDEX IF NOT EXISTS platform_jobs_idempotency_fence
    ON platform_jobs (queue, handler_kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Claim scan support: pending jobs eligible for execution.
CREATE INDEX IF NOT EXISTS platform_jobs_pending_idx
    ON platform_jobs (run_after, created_at)
    WHERE status = 'pending';

-- Terminal-state backstop: succeeded/dead jobs are immutable except for
-- updated_at bookkeeping; enforced by application CAS checks plus trigger.
CREATE OR REPLACE FUNCTION platform_jobs_terminal_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.status IN ('succeeded', 'dead') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'terminal job % cannot leave state %', OLD.job_id, OLD.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_jobs_terminal_immutable_trigger ON platform_jobs;
CREATE TRIGGER platform_jobs_terminal_immutable_trigger
    BEFORE UPDATE ON platform_jobs
    FOR EACH ROW EXECUTE FUNCTION platform_jobs_terminal_immutable();

CREATE TABLE IF NOT EXISTS platform_job_attempts (
    attempt_id     uuid        PRIMARY KEY,
    job_id         uuid        NOT NULL REFERENCES platform_jobs(job_id) ON DELETE CASCADE,
    attempt_no     integer     NOT NULL CHECK (attempt_no >= 1),
    worker_id      text        NOT NULL,
    correlation_id text        NOT NULL,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    outcome        text        CHECK (outcome IN ('running', 'succeeded', 'failed', 'dead')),
    error          jsonb
);

-- One attempt row per attempt number per job — durable attempt identity.
CREATE UNIQUE INDEX IF NOT EXISTS platform_job_attempts_fence
    ON platform_job_attempts (job_id, attempt_no);
