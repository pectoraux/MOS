-- MKT-010 Normalized execution model schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "Execution identity/lifecycle → /executions". MKT-009 delivered the
-- Workflow INSTANCE (lifecycle intent); this migration delivers the EXECUTION
-- — the actual runtime attempt identity (architecture.md §11: "An Execution
-- is one concrete operation identity for a Task according to the frozen
-- execution semantics"; "Execution is the unit that acquires runtime
-- resources").
--
-- Frozen semantics encoded here (spec/implementation-contract.md §7 "Execution
-- contract", §8 "Execution idempotency", §9 "Runtime contract", §24
-- "Error/recovery contract"; spec/state-machines.md "Execution" as SUPERSEDED
-- for Execution/Sandbox semantics by spec/state-machines-v1.2.md; v1.2
-- corrections spec/implementation-contract-v1.2.md §1/§2 and
-- spec/tenant-runtime-v1.2.md; work-items.md MKT-010 "one Execution identity
-- and lifecycle for deterministic, AI, human and extension execution";
-- EXEC-001 / EXEC-AC-01..03):
--
--   * ONE normalized Execution identity for ALL execution kinds
--     (deterministic | ai | human | extension — EXEC-AC-01): one table, one
--     lifecycle machine, one idempotency fence. Execution identity is
--     independent of provider/model/runtime implementation;
--   * the FROZEN Execution state machine (state-machines-v1.2.md, the
--     authoritative v1.2 correction of the v1.1 diagram):
--
--       CREATED → QUEUED → STARTING → RUNNING
--                                   ├→ PAUSING → PAUSED → RUNNING
--                                   ├→ SUCCEEDED
--                                   ├→ FAILED
--                                   ├→ CANCELLED
--                                   └→ UNKNOWN
--       UNKNOWN → RECONCILING
--       RECONCILING → SUCCEEDED | FAILED | UNKNOWN
--
--     Eleven states, fourteen legal edges — enforced by the database itself
--     (trigger): illegal transitions, self-loops and every transition out of
--     a TERMINAL state (succeeded/failed/cancelled) are rejected even under
--     direct SQL rewrites (EXEC-AC-02 "terminal Execution state is
--     immutable"). UNKNOWN is NON-terminal ("UNKNOWN is non-terminal until
--     reconciled", state-machines-v1.2.md) and is NEVER success;
--   * every applied transition is recorded APPEND-ONLY in
--     execution_transitions with the request idempotency key;
--     (execution_id, idempotency_key) is UNIQUE-fenced — the storage end of
--     §5-class "duplicate transition requests are idempotent" for executions;
--     a replayed request converges to the recorded transition. A transition
--     INTO failed MUST declare its retry classification (§24: "Retryable
--     failures must declare whether retry is safe"); reconciliation decisions
--     (from reconciling) may carry an authoritative external-evidence
--     reference;
--   * §8 idempotency: every execution create carries a LOGICAL idempotency
--     key, and the DATABASE enforces its uniqueness — (workspace_id,
--     idempotency_key) UNIQUE. "Application-level check-then-insert is
--     insufficient as the sole duplicate fence" — the constraint is the
--     fence: a duplicate create converges to the existing execution (same
--     request fingerprint), a key reused for a DIFFERENT logical command
--     (different fingerprint) is rejected. This is EXEC-AC-03's "retry does
--     not create duplicate logical execution effects" at the storage layer;
--   * TASK LINKAGE is REFERENCE DATA: workflow_instance_id + node_id (the
--     logical Task coordinates, §7 "the runtime attempt lifecycle associated
--     with a Task") or an explicitly declared external execution request
--     (§7 "or explicitly declared external execution request"). The frozen
--     dependency matrix (/executions ──→ /workspaces, /policies,
--     /credentials, /audit; /workflows ──→ … /executions …) gives /executions
--     NO /workflows dependency — the direction is the workflow engine CALLS
--     /executions — so these columns are deliberately WITHOUT foreign keys
--     into the workflow tables: /executions records the references, it never
--     resolves them (referential consistency is the authorized caller's
--     contract; a future runtime engine composing both authorities enforces
--     it);
--   * RETRY SEMANTICS (§6/§24, state-machines-v1.2.md): a retry creates NO
--     second logical Task identity — the retry is a NEW ATTEMPT ROW of the
--     same linkage (attempt_number = prior + 1, retry_of_execution_id → the
--     prior attempt, linkage/kind/runtime inherited). The database fences
--     duplicate retry attempts per prior execution (partial UNIQUE on
--     (retry_of_execution_id, attempt_number)), and the application gate
--     refuses every retry that is not a FAILED + retry-safe prior (UNKNOWN is
--     never automatically retryable);
--   * the runtime resource declaration (§9): runtime_class from the frozen
--     capability list (pooled-worker | ephemeral-sandbox |
--     persistent-sandbox | dedicated-runtime), immutable after creation;
--   * the SANDBOX LEASE (implementation-contract-v1.2.md §1, §9 of v1.1 as
--     superseded; tenant-runtime-v1.2.md): a lease row MUST contain
--     sandbox_id, execution_id, client_id, workspace_id, lease state/version
--     and expiry/recovery metadata. The database provides "the backstop
--     preventing two conflicting active leases for the same sandbox" — a
--     partial UNIQUE index allows exactly ONE active lease per sandbox (the
--     selected strict concurrency invariant: no sandbox contract exists yet
--     that could declare safe concurrency — that authority arrives with
--     MKT-012). execution_id is NOT part of any Sandbox identity (there is NO
--     sandbox entity here — the sandbox lifecycle authority is MKT-012); a
--     lease may only be acquired by a NON-TERMINAL execution whose
--     runtime_class is a sandbox class (not pooled-worker). Releasing a lease
--     never terminalizes the Execution — the lease tables carry NO status
--     mutation path to executions;
--   * the scope chain (Agency → Client → Workspace → Execution) is
--     server-derived and DB-backstopped on both boundary hops, exactly like
--     every workspace-scoped authority before this one.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns: execution authorization stays exactly the
-- /agencies membership authority composed with canonical owner resolution
-- (/executions → /workspaces → /clients → /agencies) — no second tenant,
-- permission, workflow or sandbox authority. No dispatch columns, no queue
-- rows, no worker assignment, no input/output payload columns, no telemetry:
-- dispatching and running work is the pooled worker/runtime authority
-- (MKT-011), and payload/telemetry recording arrives with the runtime that
-- produces it. This migration is the IDENTITY + LIFECYCLE + LEASE contract
-- only.

CREATE TABLE IF NOT EXISTS executions (
    execution_id          uuid        PRIMARY KEY,
    -- TASK LINKAGE (reference data; see header — deliberately NO FK into the
    -- workflow tables: the frozen dependency matrix points /workflows →
    -- /executions, never the reverse).
    workflow_instance_id  uuid,
    node_id               text        CHECK (node_id IS NULL OR (length(node_id) >= 1 AND length(node_id) <= 200)),
    external_request_ref  text        CHECK (external_request_ref IS NULL OR (length(external_request_ref) >= 1 AND length(external_request_ref) <= 200)),
    -- The prior attempt this execution RETRIES (null for first attempts).
    retry_of_execution_id uuid        REFERENCES executions(execution_id),
    attempt_number        integer     NOT NULL CHECK (attempt_number >= 1),
    -- The normalized execution kind (EXEC-AC-01: one identity for all kinds).
    execution_kind        text        NOT NULL
                          CHECK (execution_kind IN ('deterministic', 'ai', 'human', 'extension')),
    -- The runtime resource class (implementation-contract §9 frozen list).
    runtime_class         text        NOT NULL
                          CHECK (runtime_class IN ('pooled-worker', 'ephemeral-sandbox', 'persistent-sandbox', 'dedicated-runtime')),
    -- The §8 LOGICAL idempotency key (unique per workspace) and the fingerprint
    -- of the logical create command it fenced (a key reused with a different
    -- command is a conflict, not a convergence).
    idempotency_key       text        NOT NULL
                          CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    create_fingerprint    text        NOT NULL CHECK (length(create_fingerprint) = 64),
    -- Server-derived scope chain.
    workspace_id          uuid        NOT NULL REFERENCES workspaces(workspace_id),
    client_id             uuid        NOT NULL REFERENCES clients(client_id),
    agency_id             uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    status                text        NOT NULL DEFAULT 'created'
                          CHECK (status IN ('created', 'queued', 'starting', 'running', 'pausing', 'paused',
                                            'succeeded', 'failed', 'cancelled', 'unknown', 'reconciling')),
    -- Set ONCE, by the transition INTO failed (§24: retryable failures must
    -- declare whether retry is safe). Null until then; never reassigned.
    retry_classification  text        CHECK (retry_classification IS NULL OR retry_classification IN ('safe', 'unsafe')),
    created_by            uuid        REFERENCES users(user_id),
    version               bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    -- Exactly ONE task-linkage shape: workflow-node coordinates OR an
    -- explicitly declared external execution request (§7).
    CONSTRAINT executions_task_link_shape CHECK (
        (workflow_instance_id IS NOT NULL AND node_id IS NOT NULL AND external_request_ref IS NULL)
        OR (workflow_instance_id IS NULL AND node_id IS NULL AND external_request_ref IS NOT NULL)
    ),
    -- First attempts carry attempt 1 and no prior; retries carry >= 2 and
    -- point at the attempt they retry (§6: "A retry creates no second
    -- logical Task identity").
    CONSTRAINT executions_attempt_shape CHECK (
        (retry_of_execution_id IS NULL AND attempt_number = 1)
        OR (retry_of_execution_id IS NOT NULL AND attempt_number >= 2)
    ),
    -- The §8 logical idempotency fence: one logical create command per
    -- workspace — the database is the duplicate fence, not the application.
    CONSTRAINT executions_idempotency_key_unique UNIQUE (workspace_id, idempotency_key)
);

-- Listing surfaces: executions of one workspace, and the attempts of one
-- prior execution.
CREATE INDEX IF NOT EXISTS executions_workspace_idx
    ON executions (workspace_id, created_at, execution_id);
CREATE INDEX IF NOT EXISTS executions_linkage_idx
    ON executions (workflow_instance_id, node_id, created_at, execution_id);
CREATE INDEX IF NOT EXISTS executions_retry_of_idx
    ON executions (retry_of_execution_id) WHERE retry_of_execution_id IS NOT NULL;

-- One retry attempt per (prior, attempt number): a deliberate retry of the
-- same prior execution resolves to at most ONE next attempt row — concurrent
-- duplicate retries converge to exactly one winner (EXEC-AC-03 retry fence).
CREATE UNIQUE INDEX IF NOT EXISTS executions_retry_attempt_unique
    ON executions (retry_of_execution_id, attempt_number) WHERE retry_of_execution_id IS NOT NULL;

-- The append-only transition history: one row per APPLIED transition, with
-- the request idempotency key that fenced it.
CREATE TABLE IF NOT EXISTS execution_transitions (
    transition_id        uuid        PRIMARY KEY,
    execution_id         uuid        NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
    idempotency_key      text        NOT NULL CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    from_status          text        NOT NULL
                         CHECK (from_status IN ('created', 'queued', 'starting', 'running', 'pausing', 'paused',
                                                'succeeded', 'failed', 'cancelled', 'unknown', 'reconciling')),
    to_status            text        NOT NULL
                         CHECK (to_status IN ('created', 'queued', 'starting', 'running', 'pausing', 'paused',
                                              'succeeded', 'failed', 'cancelled', 'unknown', 'reconciling')),
    -- The §24 retry-safety declaration — REQUIRED on every transition INTO
    -- failed (enforced by trigger below), forbidden elsewhere.
    retry_classification text        CHECK (retry_classification IS NULL OR retry_classification IN ('safe', 'unsafe')),
    -- Authoritative external-evidence reference for reconciliation decisions
    -- (state-machines-v1.2.md: "Reconciliation must use authoritative
    -- external evidence where available") — allowed ONLY on reconciling →
    -- succeeded/failed/unknown decisions (enforced by trigger below). An
    -- opaque reference: the /evidence authority (MKT-013) owns evidence.
    evidence_ref         text        CHECK (evidence_ref IS NULL OR (length(evidence_ref) >= 1 AND length(evidence_ref) <= 512)),
    reason               text        NOT NULL DEFAULT '',
    created_by           uuid        REFERENCES users(user_id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- The transition idempotency fence: within one execution a request key
    -- resolves to at most ONE applied transition — replayed duplicate
    -- transition requests converge to the recorded row.
    CONSTRAINT execution_transitions_key_unique UNIQUE (execution_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS execution_transitions_execution_idx
    ON execution_transitions (execution_id, created_at, transition_id);

-- The FROZEN Execution transition table as a predicate function (single
-- source of truth shared by the execution-row trigger and the history-insert
-- trigger) — state-machines.md "Execution" as superseded by
-- state-machines-v1.2.md:
--   created  → queued
--   queued   → starting
--   starting → running
--   running  → pausing | succeeded | failed | cancelled | unknown
--   pausing  → paused
--   paused   → running
--   unknown  → reconciling
--   reconciling → succeeded | failed | unknown
-- and NOTHING else. No self-loops; no skip-edges; the three terminal states
-- (succeeded/failed/cancelled) have no outgoing transitions ("Terminal
-- states are SUCCEEDED, FAILED, and CANCELLED", state-machines-v1.2.md).
CREATE OR REPLACE FUNCTION execution_transition_legal(from_status text, to_status text)
RETURNS boolean AS $$
BEGIN
    RETURN (
        (from_status = 'created' AND to_status = 'queued')
        OR (from_status = 'queued' AND to_status = 'starting')
        OR (from_status = 'starting' AND to_status = 'running')
        OR (from_status = 'running' AND to_status IN ('pausing', 'succeeded', 'failed', 'cancelled', 'unknown'))
        OR (from_status = 'pausing' AND to_status = 'paused')
        OR (from_status = 'paused' AND to_status = 'running')
        OR (from_status = 'unknown' AND to_status = 'reconciling')
        OR (from_status = 'reconciling' AND to_status IN ('succeeded', 'failed', 'unknown'))
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- State-machine backstop: the database itself rejects every illegal status
-- change on an execution — illegal transitions, self-loops, and any change
-- (status or otherwise) to a TERMINAL execution (succeeded/failed/cancelled
-- rows are fully frozen history). Even a direct SQL rewrite cannot move an
-- execution outside the frozen machine (EXEC-AC-02).
CREATE OR REPLACE FUNCTION executions_frozen_state_machine() RETURNS trigger AS $$
BEGIN
    IF NOT execution_transition_legal(OLD.status, NEW.status) THEN
        IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
            RAISE EXCEPTION 'execution % is % (terminal) and frozen: terminal states are immutable',
                OLD.execution_id, OLD.status;
        END IF;
        IF OLD.status = NEW.status THEN
            RAISE EXCEPTION 'execution % self-transition % → % is illegal (no self-loops in the frozen state machine)',
                OLD.execution_id, OLD.status, NEW.status;
        END IF;
        RAISE EXCEPTION 'illegal execution transition % → % (frozen execution state machine)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS executions_frozen_state_machine_trigger ON executions;
CREATE TRIGGER executions_frozen_state_machine_trigger
    BEFORE UPDATE ON executions
    FOR EACH ROW EXECUTE FUNCTION executions_frozen_state_machine();

-- Immutability backstop (implementation-contract §3): execution identity,
-- the task linkage, the retry provenance, the attempt number, the kind, the
-- runtime class, the idempotency key, the create fingerprint, the scope and
-- the provenance can NEVER be reassigned through ANY mutation path. The ONLY
-- additional mutable field is the retry classification — and it is SET-ONCE,
-- exclusively by the transition INTO failed (a failure that has declared its
-- retry safety can never silently re-declare it).
CREATE OR REPLACE FUNCTION executions_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.execution_id <> OLD.execution_id THEN
        RAISE EXCEPTION 'execution_id % is immutable', OLD.execution_id;
    END IF;
    IF NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id
       OR NEW.node_id IS DISTINCT FROM OLD.node_id
       OR NEW.external_request_ref IS DISTINCT FROM OLD.external_request_ref THEN
        RAISE EXCEPTION 'execution % task linkage is immutable (was instance % / node % / external %)',
            OLD.execution_id, OLD.workflow_instance_id, OLD.node_id, OLD.external_request_ref;
    END IF;
    IF NEW.retry_of_execution_id IS DISTINCT FROM OLD.retry_of_execution_id THEN
        RAISE EXCEPTION 'execution % retry provenance is immutable (was retry of %)',
            OLD.execution_id, OLD.retry_of_execution_id;
    END IF;
    IF NEW.attempt_number <> OLD.attempt_number THEN
        RAISE EXCEPTION 'execution % attempt number is immutable (was %)',
            OLD.execution_id, OLD.attempt_number;
    END IF;
    IF NEW.execution_kind <> OLD.execution_kind THEN
        RAISE EXCEPTION 'execution % kind is immutable (was %)',
            OLD.execution_id, OLD.execution_kind;
    END IF;
    IF NEW.runtime_class <> OLD.runtime_class THEN
        RAISE EXCEPTION 'execution % runtime class is immutable (was %) — the runtime resource declaration never changes identity',
            OLD.execution_id, OLD.runtime_class;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key OR NEW.create_fingerprint <> OLD.create_fingerprint THEN
        RAISE EXCEPTION 'execution % idempotency identity is immutable', OLD.execution_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'execution % cannot change Workspace scope (was workspace %)',
            OLD.execution_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'execution % Client ownership is immutable (was client %)',
            OLD.execution_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'execution % cannot change Agency ownership (was agency %)',
            OLD.execution_id, OLD.agency_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'execution % provenance is immutable', OLD.execution_id;
    END IF;
    IF NEW.retry_classification IS DISTINCT FROM OLD.retry_classification THEN
        IF OLD.retry_classification IS NOT NULL THEN
            RAISE EXCEPTION 'execution % retry classification is immutable (was %)',
                OLD.execution_id, OLD.retry_classification;
        END IF;
        IF NEW.status <> 'failed' OR NEW.retry_classification NOT IN ('safe', 'unsafe') THEN
            RAISE EXCEPTION 'execution % retry classification can only be SET once, by the transition INTO failed',
                OLD.execution_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS executions_identity_immutable_trigger ON executions;
CREATE TRIGGER executions_identity_immutable_trigger
    BEFORE UPDATE ON executions
    FOR EACH ROW EXECUTE FUNCTION executions_identity_immutable();

-- Scope backstop (same posture as every workspace-scoped authority): an
-- execution's Client must be the Client that owns the recorded Workspace,
-- and its Agency must be the Agency that owns that Client — enforced on
-- INSERT and UPDATE, so the scope chain (Agency → Client → Workspace →
-- Execution) cannot be crossed through any column even if every application
-- check were bypassed.
CREATE OR REPLACE FUNCTION executions_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'execution % workspace % does not belong to client %',
            NEW.execution_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'execution % client % does not belong to agency %',
            NEW.execution_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS executions_scope_chain_trigger ON executions;
CREATE TRIGGER executions_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON executions
    FOR EACH ROW EXECUTE FUNCTION executions_scope_chain();

-- History legality backstop: only a legal frozen-machine pair can be
-- RECORDED as a transition row (defense in depth — the row history can never
-- claim an illegal transition even if written by direct SQL), and the §24
-- payload contracts hold at the storage layer: every transition INTO failed
-- declares its retry classification; the reconciliation-decision evidence
-- reference appears only on reconciling → succeeded/failed/unknown rows.
CREATE OR REPLACE FUNCTION execution_transitions_legal() RETURNS trigger AS $$
BEGIN
    IF NOT execution_transition_legal(NEW.from_status, NEW.to_status) THEN
        RAISE EXCEPTION 'illegal execution transition % → % cannot be recorded',
            NEW.from_status, NEW.to_status;
    END IF;
    IF NEW.to_status = 'failed' AND NEW.retry_classification IS NULL THEN
        RAISE EXCEPTION 'transition INTO failed must declare retry classification (safe | unsafe) on execution % — retryable failures must declare whether retry is safe',
            NEW.execution_id;
    END IF;
    IF NEW.to_status <> 'failed' AND NEW.retry_classification IS NOT NULL THEN
        RAISE EXCEPTION 'retry classification is only declarable on transitions INTO failed (execution %)',
            NEW.execution_id;
    END IF;
    IF NEW.evidence_ref IS NOT NULL
       AND NOT (NEW.from_status = 'reconciling' AND NEW.to_status IN ('succeeded', 'failed', 'unknown')) THEN
        RAISE EXCEPTION 'external evidence references are only recordable on reconciliation decisions (reconciling → succeeded | failed | unknown) on execution %',
            NEW.execution_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_transitions_legal_trigger ON execution_transitions;
CREATE TRIGGER execution_transitions_legal_trigger
    BEFORE INSERT ON execution_transitions
    FOR EACH ROW EXECUTE FUNCTION execution_transitions_legal();

-- Append-only backstop: applied-transition history is immutable evidence —
-- UPDATE and DELETE are both rejected by the database itself.
CREATE OR REPLACE FUNCTION execution_transitions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'execution transitions are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_transitions_append_only_trigger ON execution_transitions;
CREATE TRIGGER execution_transitions_append_only_trigger
    BEFORE UPDATE OR DELETE ON execution_transitions
    FOR EACH ROW EXECUTE FUNCTION execution_transitions_append_only();

-- ---------------------------------------------------------------------------
-- The SANDBOX LEASE (implementation-contract-v1.2.md §1 / tenant-runtime-
-- v1.2.md). There is deliberately NO sandbox entity and NO sandbox lifecycle
-- here: the runtime/sandbox authority is MKT-012. What /executions owns is
-- the RELATIONSHIP — the durable lease an Execution holds on a sandbox:
--
--   * lease identity (tenant-runtime-v1.2.md): sandbox_lease_id + sandbox_id
--     + execution_id + client_id + workspace_id — all immutable;
--   * the lease carries state/version and expiry/recovery metadata;
--   * the database enforces "the backstop preventing two conflicting active
--     leases for the same sandbox" (partial UNIQUE below) and one active
--     lease per execution;
--   * releasing a lease never terminalizes the Execution: nothing in this
--     schema mutates executions.status from the lease tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_sandbox_leases (
    sandbox_lease_id  uuid        PRIMARY KEY,
    -- Opaque sandbox reference (the sandbox lifecycle authority is MKT-012;
    -- no FK — there is no sandbox table yet, and execution_id is never
    -- Sandbox identity).
    sandbox_id        text        NOT NULL
                      CHECK (length(sandbox_id) >= 1 AND length(sandbox_id) <= 200),
    execution_id      uuid        NOT NULL REFERENCES executions(execution_id) ON DELETE CASCADE,
    workspace_id      uuid        NOT NULL REFERENCES workspaces(workspace_id),
    client_id         uuid        NOT NULL REFERENCES clients(client_id),
    status            text        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released')),
    acquired_by       uuid        REFERENCES users(user_id),
    released_at       timestamptz,
    -- Expiry/recovery metadata: when set, an active lease whose expires_at
    -- has passed is STALE and reclaimable through the idempotent release
    -- operation (the deterministic pre-worker recovery path; the durable
    -- worker/outbox automation arrives with MKT-011).
    expires_at        timestamptz,
    version           bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    idempotency_key   text        NOT NULL
                      CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT execution_sandbox_leases_key_unique UNIQUE (execution_id, idempotency_key),
    CONSTRAINT execution_sandbox_leases_release_shape CHECK (
        (status = 'active' AND released_at IS NULL)
        OR (status = 'released' AND released_at IS NOT NULL)
    )
);

-- THE v1.2 CONCURRENCY BACKSTOP: at most ONE active lease controls a sandbox
-- at a time (the strict invariant — no sandbox contract exists yet that
-- could declare safe concurrency; MKT-012 owns relaxing it for contracts
-- that do). Concurrent acquisitions of the same sandbox converge to
-- exactly one winner; every loser is rejected by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS execution_sandbox_leases_one_active_per_sandbox
    ON execution_sandbox_leases (sandbox_id) WHERE status = 'active';

-- One ACTIVE lease per execution at a time (sequential re-leasing after a
-- release is legal — new lease row): the execution holds at most one
-- runtime environment at any moment.
CREATE UNIQUE INDEX IF NOT EXISTS execution_sandbox_leases_one_active_per_execution
    ON execution_sandbox_leases (execution_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS execution_sandbox_leases_execution_idx
    ON execution_sandbox_leases (execution_id, created_at, sandbox_lease_id);

-- Lease-eligibility backstop: a lease can only be acquired for a
-- NON-TERMINAL execution whose runtime class is a SANDBOX class — a
-- pooled-worker execution holds no sandbox (tenant-runtime-model.md compute
-- allocation), and a terminal execution acquires no new runtime resources.
CREATE OR REPLACE FUNCTION execution_sandbox_leases_eligible() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM executions e
        WHERE e.execution_id = NEW.execution_id
          AND e.workspace_id = NEW.workspace_id
          AND e.client_id = NEW.client_id
          AND e.status NOT IN ('succeeded', 'failed', 'cancelled')
          AND e.runtime_class <> 'pooled-worker'
    ) THEN
        RAISE EXCEPTION 'sandbox leases are only acquirable by non-terminal sandbox-class executions (execution %)',
            NEW.execution_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_sandbox_leases_eligible_trigger ON execution_sandbox_leases;
CREATE TRIGGER execution_sandbox_leases_eligible_trigger
    BEFORE INSERT ON execution_sandbox_leases
    FOR EACH ROW EXECUTE FUNCTION execution_sandbox_leases_eligible();

-- Lease immutability + lifecycle backstop: lease identity (sandbox_id,
-- execution_id, scope), the acquisition provenance, the idempotency key and
-- the expiry metadata are immutable; the ONLY legal lease mutation is the
-- idempotent ACTIVE → RELEASED release (released leases are frozen terminal
-- rows — a released lease is never resurrected and never re-pointed).
CREATE OR REPLACE FUNCTION execution_sandbox_leases_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'released' THEN
        RAISE EXCEPTION 'sandbox lease % is released (terminal) and frozen',
            OLD.sandbox_lease_id;
    END IF;
    IF NEW.status NOT IN ('active', 'released') THEN
        RAISE EXCEPTION 'sandbox lease % status must be active or released',
            OLD.sandbox_lease_id;
    END IF;
    IF NEW.sandbox_lease_id <> OLD.sandbox_lease_id THEN
        RAISE EXCEPTION 'sandbox_lease_id % is immutable', OLD.sandbox_lease_id;
    END IF;
    IF NEW.sandbox_id <> OLD.sandbox_id OR NEW.execution_id <> OLD.execution_id THEN
        RAISE EXCEPTION 'sandbox lease % identity tuple (sandbox %, execution %) is immutable',
            OLD.sandbox_lease_id, OLD.sandbox_id, OLD.execution_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id OR NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'sandbox lease % scope is immutable', OLD.sandbox_lease_id;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.acquired_by IS DISTINCT FROM OLD.acquired_by
       OR NEW.created_at <> OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'sandbox lease % acquisition contract is immutable', OLD.sandbox_lease_id;
    END IF;
    IF NEW.status = 'released' AND NEW.released_at IS NULL THEN
        RAISE EXCEPTION 'sandbox lease % release must record released_at', OLD.sandbox_lease_id;
    END IF;
    IF NEW.status = 'active' AND (NEW.released_at IS NOT NULL OR OLD.status = 'released') THEN
        RAISE EXCEPTION 'sandbox lease % cannot return to active after release', OLD.sandbox_lease_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_sandbox_leases_immutable_trigger ON execution_sandbox_leases;
CREATE TRIGGER execution_sandbox_leases_immutable_trigger
    BEFORE UPDATE ON execution_sandbox_leases
    FOR EACH ROW EXECUTE FUNCTION execution_sandbox_leases_immutable();
