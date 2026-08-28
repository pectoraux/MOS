-- MKT-012 Execution sandboxes schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map composed with the v1.2
-- runtime clarifications (spec/implementation-clarifications-v1.2.md "Runtime
-- authority": "/executions is the authoritative application boundary for
-- runtime allocation records because runtime acquisition is part of Execution
-- lifecycle. Sandbox objects are Workspace/Client scoped, but their lifecycle
-- and lease records are governed through the execution/runtime contract
-- exposed by /executions. This does not mean Execution owns Sandbox business
-- data. It means there is one authoritative runtime allocation boundary and
-- no second runtime engine."): the sandbox lifecycle authority lives on the
-- /executions surface. There is NO /runtime or /sandboxes module — the frozen
-- module dependency matrix has no such row.
--
-- Frozen semantics encoded here (spec/work-items.md MKT-012 "implement
-- ephemeral/persistent/dedicated sandbox contracts and lifecycle without
-- creating a second execution authority"; spec/work-item-v1.2-overrides.md
-- MKT-012; spec/implementation-contract-v1.2.md §1 "Runtime resource
-- ownership", §3 "Persistent execution context"; spec/tenant-runtime-v1.2.md;
-- spec/state-machines.md "Sandbox" as reaffirmed by
-- spec/state-machines-v1.2.md; requirements.md RUNTIME-001, acceptance
-- RUNTIME-AC-01..04 with RUNTIME-AC-02 superseded by
-- spec/architecture-lock-v1.4.md #8: "persistent Sandbox identity is
-- Workspace/Client-scoped; Sandbox Lease identity is Execution-scoped"):
--
--   * the SANDBOX identity tuple is IMMUTABLE and contains NO execution
--     ownership (tenant-runtime-v1.2.md "Sandbox identity":
--     sandbox_id + client_id + workspace_id + runtime_class +
--     environment_identity; "execution_id is NOT part of Sandbox identity";
--     implementation-contract-v1.2.md §1 "The Sandbox entity MUST NOT contain
--     execution_id as an ownership field"). Ephemeral sandboxes are scoped to
--     one bounded Execution's LIFETIME through the LEASE, never through
--     identity (work-item-v1.2-overrides.md: "Ephemeral sandboxes may be
--     execution scoped" — the lease is that scope);
--   * the three sandbox classes (tenant-runtime-model.md compute
--     allocation / tenant-runtime-v1.2.md): ephemeral-sandbox (created for a
--     bounded execution and released afterward), persistent-sandbox
--     (workspace-scoped environment leased to authorized executions — may
--     survive individual executions and be REUSED by later authorized
--     executions in the same workspace; "Reuse never reuses Execution
--     identity or workflow/task identity"), dedicated-runtime
--     (client/workload-scoped environment that can host multiple executions
--     subject to policy). pooled-worker is NOT a sandbox class — a
--     pooled-worker execution holds no sandbox;
--   * environment_identity: the caller-named environment key for the
--     REUSABLE classes (persistent/dedicated — one LIVE sandbox per
--     (workspace, runtime_class, environment_identity), the DB fence that
--     makes reuse deterministic and crash-safe: "A crash must not create a
--     second Sandbox"), and a SERVER-GENERATED nonce for the ephemeral class
--     (never caller-named: an ephemeral sandbox is never reused, so its
--     environment identity is unique per provisioning);
--   * the FROZEN Sandbox state machine (state-machines.md "Sandbox",
--     unchanged by state-machines-v1.2.md):
--
--       REQUESTED → PREPARING → READY
--                        ├→ FAILED
--                        └→ CANCELLED
--       READY → RELEASING → RELEASED
--       READY → CANCELLED → RELEASED
--
--     Seven states, EIGHT legal edges — enforced by the database itself
--     (trigger): illegal transitions and every transition out of a TERMINAL
--     state (failed/released) are rejected even under direct SQL rewrites.
--     NOTE the frozen shape: REQUESTED's only forward edge is PREPARING (a
--     requested sandbox cannot be cancelled directly — the machine has no
--     requested → cancelled edge), and CANCELLED is NOT terminal (its only
--     forward edge is RELEASED — teardown still runs);
--   * every applied transition is recorded APPEND-ONLY in
--     sandbox_transitions with the request idempotency key;
--     (sandbox_id, idempotency_key) is UNIQUE-fenced (the §8-class logical
--     command fence). A transition INTO failed MUST record its reason (the
--     provisioning failure). The history trigger resolves the sandbox row
--     (FOR UPDATE — concurrency-safe, sharing the authorized path's row
--     lock) and rejects any history row whose from_status does not equal the
--     sandbox's durable current status — the fabricated-history backstop the
--     MKT-010 audit erratum established for execution_transitions, applied
--     to this ledger from day one (spec/errata/MKT-010-history-ledger.md);
--   * the sandbox DECLARED RUNTIME CONTRACT (tenant-runtime-v1.2.md: "Only
--     one active lease may control a Sandbox at a time unless the Sandbox
--     contract explicitly declares safe concurrency. The database must
--     enforce the selected concurrency invariant"): concurrency_contract is
--     an immutable sandbox attribute — 'exclusive' (the default, the strict
--     v1.2 invariant) or 'concurrent-safe' (the contract that explicitly
--     permits safe concurrent use — the dedicated-runtime shape). The lease
--     table RECORDS the contract at acquisition and the partial UNIQUE
--     backstop is selected by it: at most ONE active lease per EXCLUSIVE
--     sandbox; a concurrent-safe sandbox may be concurrently controlled by
--     multiple active leases (each execution still holds at most one active
--     lease at a time);
--   * lease acquisition now validates the SANDBOX side of the relationship
--     (DB backstop on lease INSERT): the sandbox MUST exist, be READY, be in
--     the SAME client and workspace as the execution (work-item-v1.2
--     overrides: "Cross-client sharing is forbidden"), be of the SAME
--     runtime class as the execution's declared runtime class, and the lease
--     must record the sandbox's declared concurrency contract;
--   * teardown gating (the release path is lease-aware): a sandbox cannot
--     enter RELEASING, CANCELLED or RELEASED while an ACTIVE lease controls
--     it — leases are released first (by their owner execution or through
--     the deterministic stale-lease reclamation), then the environment is
--     torn down. Releasing a sandbox NEVER terminalizes or transitions any
--     Execution: nothing in this schema mutates executions from the sandbox
--     tables (a sandbox may never transition an Execution directly —
--     tenant-runtime-v1.2.md "Lifecycle authority");
--   * the scope chain (Agency → Client → Workspace → Sandbox) is
--     server-derived and DB-backstopped (the sandbox's client_id must equal
--     its workspace's owning client — the cross-client fence at the storage
--     layer);
--   * §8 idempotency on provisioning: (workspace_id, idempotency_key)
--     UNIQUE + a provision fingerprint — a duplicate provisioning command
--     converges, a key reused for a different command is rejected (same
--     storage pattern as executions).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation,
-- set-once fields for one-way evidence (resource_descriptor at ready,
-- prepare_error at failed, released_at at released). NO credential, secret,
-- token or key material columns: sandbox credentials are injected
-- just-in-time according to execution policy and are never stored as
-- ordinary domain fields (tenant-runtime-model.md hard rule 6;
-- RUNTIME-AC-03) — the resource_descriptor is an opaque driver handle, and
-- a static architecture test pins that no credential-shaped column or field
-- exists in this schema or the sandbox code paths.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The SANDBOX entity: the runtime ENVIRONMENT identity (never an Execution
-- identity).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sandboxes (
    sandbox_id           uuid        PRIMARY KEY,
    -- Scope: a sandbox is Workspace/Client-scoped (v1.2/v1.4). The owning
    -- client is derived from the workspace chain and DB-backstopped below.
    client_id            uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id         uuid        NOT NULL REFERENCES workspaces(workspace_id),
    -- The runtime class of the environment — one of the three SANDBOX
    -- classes (a pooled-worker execution holds no sandbox; the classes map
    -- 1:1 to the frozen RuntimeClass values).
    runtime_class        text        NOT NULL
                         CHECK (runtime_class IN ('ephemeral-sandbox', 'persistent-sandbox', 'dedicated-runtime')),
    -- The environment identity: caller-named for the reusable classes,
    -- server-generated nonce for the ephemeral class (never reused).
    environment_identity text        NOT NULL
                         CHECK (length(environment_identity) >= 1 AND length(environment_identity) <= 200),
    -- Declared required capabilities (the Work-Order "required capabilities"
    -- field, implementation-contract-v1.2.md §4). A bounded JSON array of
    -- short strings; item shape is validated by the module (the DB pins the
    -- array type and size). NEVER credentials (RUNTIME-AC-03).
    capabilities         jsonb       NOT NULL DEFAULT '[]'::jsonb
                         CHECK (jsonb_typeof(capabilities) = 'array'
                                AND jsonb_array_length(capabilities) <= 16),
    -- The DECLARED RUNTIME CONTRACT: 'exclusive' (strict one-controller
    -- invariant) or 'concurrent-safe' (the contract explicitly permitting
    -- safe concurrent use). Selects the lease concurrency invariant below.
    concurrency_contract text        NOT NULL DEFAULT 'exclusive'
                         CHECK (concurrency_contract IN ('exclusive', 'concurrent-safe')),
    status               text        NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested', 'preparing', 'ready', 'failed',
                                           'cancelled', 'releasing', 'released')),
    -- Set-once at ready: the opaque driver-reported environment handle (the
    -- runtime resource state). Never credential material.
    resource_descriptor  text
                         CHECK (resource_descriptor IS NULL OR (length(resource_descriptor) >= 1 AND length(resource_descriptor) <= 512)),
    -- Set-once at failed: the recorded provisioning failure reason.
    prepare_error        text
                         CHECK (prepare_error IS NULL OR (length(prepare_error) >= 1 AND length(prepare_error) <= 2000)),
    -- Set-once at released: the teardown completion timestamp.
    released_at          timestamptz,
    version              bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    idempotency_key      text        NOT NULL
                         CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    provision_fingerprint text       NOT NULL CHECK (length(provision_fingerprint) = 64),
    created_by           uuid        REFERENCES users(user_id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sandboxes_key_unique UNIQUE (workspace_id, idempotency_key),
    CONSTRAINT sandboxes_release_shape CHECK (
        (status <> 'released' AND released_at IS NULL)
        OR (status = 'released' AND released_at IS NOT NULL)
    )
);

-- THE LIVE-ENVIRONMENT FENCE: at most ONE live sandbox per
-- (workspace, runtime_class, environment_identity). 'Live' = every state
-- except the two terminal teardown outcomes (failed, released): a failed
-- provisioning or a released environment may be re-provisioned under the
-- same environment identity as a NEW sandbox row, but a live environment is
-- never duplicated — "A crash must not create a second Sandbox"
-- (tenant-runtime-v1.2.md) and persistent/dedicated REUSE converges to the
-- one live environment (the ephemeral nonce never collides).
CREATE UNIQUE INDEX IF NOT EXISTS sandboxes_live_environment_unique
    ON sandboxes (workspace_id, runtime_class, environment_identity)
    WHERE status NOT IN ('failed', 'released');

CREATE INDEX IF NOT EXISTS sandboxes_workspace_idx
    ON sandboxes (workspace_id, created_at, sandbox_id);

-- ---------------------------------------------------------------------------
-- The append-only applied-transition ledger (the record of every lifecycle
-- decision and the provisioning/teardown idempotency ledger).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sandbox_transitions (
    sandbox_transition_id uuid       PRIMARY KEY,
    sandbox_id            uuid       NOT NULL REFERENCES sandboxes(sandbox_id) ON DELETE CASCADE,
    idempotency_key       text       NOT NULL
                          CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    from_status           text       NOT NULL
                          CHECK (from_status IN ('requested', 'preparing', 'ready', 'failed',
                                                 'cancelled', 'releasing', 'released')),
    to_status             text       NOT NULL
                          CHECK (to_status IN ('preparing', 'ready', 'failed',
                                               'cancelled', 'releasing', 'released')),
    reason                text       CHECK (reason IS NULL OR (length(reason) >= 1 AND length(reason) <= 2000)),
    created_by            uuid       REFERENCES users(user_id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sandbox_transitions_key_unique UNIQUE (sandbox_id, idempotency_key),
    CONSTRAINT sandbox_transitions_shape CHECK (from_status <> to_status)
);

CREATE INDEX IF NOT EXISTS sandbox_transitions_sandbox_idx
    ON sandbox_transitions (sandbox_id, created_at, sandbox_transition_id);

-- The frozen legal-edge predicate (8 edges, exhaustive against
-- state-machines.md "Sandbox" / state-machines-v1.2.md "Sandbox").
CREATE OR REPLACE FUNCTION sandbox_transition_legal(from_status text, to_status text)
RETURNS boolean AS $$
    SELECT CASE
        WHEN from_status = 'requested' THEN to_status = 'preparing'
        WHEN from_status = 'preparing' THEN to_status IN ('ready', 'failed', 'cancelled')
        WHEN from_status = 'ready' THEN to_status IN ('releasing', 'cancelled')
        WHEN from_status = 'releasing' THEN to_status = 'released'
        WHEN from_status = 'cancelled' THEN to_status = 'released'
        ELSE false
    END;
$$ LANGUAGE sql IMMUTABLE;

-- History legality: the legal (from,to) edge, no self-loops, and a
-- transition INTO failed MUST record its reason (the provisioning failure).
CREATE OR REPLACE FUNCTION sandbox_transitions_legal() RETURNS trigger AS $$
BEGIN
    IF NOT sandbox_transition_legal(NEW.from_status, NEW.to_status) THEN
        RAISE EXCEPTION 'illegal sandbox transition % → % (the frozen sandbox state machine)',
            NEW.from_status, NEW.to_status;
    END IF;
    IF NEW.to_status = 'failed' AND (NEW.reason IS NULL OR length(NEW.reason) = 0) THEN
        RAISE EXCEPTION 'sandbox transition into failed must record its reason';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandbox_transitions_legal_trigger ON sandbox_transitions;
CREATE TRIGGER sandbox_transitions_legal_trigger
    BEFORE INSERT ON sandbox_transitions
    FOR EACH ROW EXECUTE FUNCTION sandbox_transitions_legal();

-- History/row consistency (the MKT-010 audit-erratum backstop, applied from
-- day one): a recorded transition is the record of a decision that WAS
-- APPLIED — the trigger resolves the sandbox row concurrency-safely (FOR
-- UPDATE — re-entrant under the authorized path's row lock) and rejects
-- history rows whose from_status does not equal the sandbox's durable
-- current status, and any history row for an unknown sandbox.
CREATE OR REPLACE FUNCTION sandbox_transitions_consistent() RETURNS trigger AS $$
DECLARE
    v_current_status text;
BEGIN
    SELECT status INTO v_current_status FROM sandboxes
     WHERE sandbox_id = NEW.sandbox_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot record a transition for unknown sandbox %', NEW.sandbox_id;
    END IF;
    IF v_current_status <> NEW.from_status THEN
        RAISE EXCEPTION 'fabricated applied transition rejected: sandbox % is durably % but the history row claims from_status %',
            NEW.sandbox_id, v_current_status, NEW.from_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandbox_transitions_consistent_trigger ON sandbox_transitions;
CREATE TRIGGER sandbox_transitions_consistent_trigger
    BEFORE INSERT ON sandbox_transitions
    FOR EACH ROW EXECUTE FUNCTION sandbox_transitions_consistent();

-- The ledger is append-only: applied history is never rewritten.
CREATE OR REPLACE FUNCTION sandbox_transitions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'sandbox transition history % is append-only', OLD.sandbox_transition_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandbox_transitions_append_only_trigger ON sandbox_transitions;
CREATE TRIGGER sandbox_transitions_append_only_trigger
    BEFORE UPDATE OR DELETE ON sandbox_transitions
    FOR EACH ROW EXECUTE FUNCTION sandbox_transitions_append_only();

-- ---------------------------------------------------------------------------
-- The sandbox row lifecycle backstops.
-- ---------------------------------------------------------------------------

-- The FROZEN state machine on the row: only legal edges (same-status
-- bookkeeping updates pass through — the identity trigger below still
-- freezes every identity field), terminal states (failed/released) reject
-- every status change, and the one-way payload evidence is present when the
-- corresponding state is entered (descriptor at ready, failure reason at
-- failed, released_at at released).
CREATE OR REPLACE FUNCTION sandboxes_frozen_state_machine() RETURNS trigger AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF NOT sandbox_transition_legal(OLD.status, NEW.status) THEN
        RAISE EXCEPTION 'illegal sandbox transition % → % (sandbox %)',
            OLD.status, NEW.status, OLD.sandbox_id;
    END IF;
    IF NEW.status = 'ready' AND NEW.resource_descriptor IS NULL THEN
        RAISE EXCEPTION 'sandbox % entering ready must record its resource descriptor', OLD.sandbox_id;
    END IF;
    IF NEW.status = 'failed' AND (NEW.prepare_error IS NULL OR length(NEW.prepare_error) = 0) THEN
        RAISE EXCEPTION 'sandbox % entering failed must record its provisioning failure', OLD.sandbox_id;
    END IF;
    IF NEW.status = 'released' AND NEW.released_at IS NULL THEN
        RAISE EXCEPTION 'sandbox % entering released must record released_at', OLD.sandbox_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandboxes_frozen_state_machine_trigger ON sandboxes;
CREATE TRIGGER sandboxes_frozen_state_machine_trigger
    BEFORE UPDATE ON sandboxes
    FOR EACH ROW EXECUTE FUNCTION sandboxes_frozen_state_machine();

-- Identity immutability: the sandbox identity tuple (scope + runtime class +
-- environment identity), the declared contract (capabilities, concurrency
-- contract) and the provisioning provenance (key, fingerprint, creator,
-- created_at) never change. The one-way payload evidence is SET-ONCE at its
-- entering edge (resource_descriptor at ready, prepare_error at failed,
-- released_at at released) and immutable afterwards — a NULL→value write is
-- accepted ONLY on that entering edge; any value→value rewrite or clear is
-- rejected. The ONLY freely mutable fields are the lifecycle status,
-- version and updated_at.
CREATE OR REPLACE FUNCTION sandboxes_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.sandbox_id <> OLD.sandbox_id THEN
        RAISE EXCEPTION 'sandbox_id % is immutable', OLD.sandbox_id;
    END IF;
    IF NEW.client_id <> OLD.client_id OR NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'sandbox % scope (client %, workspace %) is immutable',
            OLD.sandbox_id, OLD.client_id, OLD.workspace_id;
    END IF;
    IF NEW.runtime_class <> OLD.runtime_class THEN
        RAISE EXCEPTION 'sandbox % runtime class is immutable', OLD.sandbox_id;
    END IF;
    IF NEW.environment_identity <> OLD.environment_identity THEN
        RAISE EXCEPTION 'sandbox % environment identity is immutable', OLD.sandbox_id;
    END IF;
    IF NEW.capabilities <> OLD.capabilities THEN
        RAISE EXCEPTION 'sandbox % declared capabilities are immutable', OLD.sandbox_id;
    END IF;
    IF NEW.concurrency_contract <> OLD.concurrency_contract THEN
        RAISE EXCEPTION 'sandbox % concurrency contract is immutable (the declared runtime contract)',
            OLD.sandbox_id;
    END IF;
    IF NEW.idempotency_key <> OLD.idempotency_key
       OR NEW.provision_fingerprint <> OLD.provision_fingerprint
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'sandbox % provisioning provenance is immutable', OLD.sandbox_id;
    END IF;
    IF (OLD.resource_descriptor IS NOT NULL AND NEW.resource_descriptor IS DISTINCT FROM OLD.resource_descriptor)
       OR (OLD.resource_descriptor IS NULL AND NEW.resource_descriptor IS NOT NULL AND NEW.status <> 'ready') THEN
        RAISE EXCEPTION 'sandbox % resource descriptor is set once at ready and immutable',
            OLD.sandbox_id;
    END IF;
    IF (OLD.prepare_error IS NOT NULL AND NEW.prepare_error IS DISTINCT FROM OLD.prepare_error)
       OR (OLD.prepare_error IS NULL AND NEW.prepare_error IS NOT NULL AND NEW.status <> 'failed') THEN
        RAISE EXCEPTION 'sandbox % provisioning failure is set once at failed and immutable',
            OLD.sandbox_id;
    END IF;
    IF (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
       OR (OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND NEW.status <> 'released') THEN
        RAISE EXCEPTION 'sandbox % released_at is set once at released and immutable',
            OLD.sandbox_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandboxes_identity_immutable_trigger ON sandboxes;
CREATE TRIGGER sandboxes_identity_immutable_trigger
    BEFORE UPDATE ON sandboxes
    FOR EACH ROW EXECUTE FUNCTION sandboxes_identity_immutable();

-- Scope chain (Agency → Client → Workspace → Sandbox): the sandbox's
-- client_id must equal its workspace's owning client — a sandbox can never
-- be cross-scoped between a workspace and a foreign client.
CREATE OR REPLACE FUNCTION sandboxes_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
         WHERE w.workspace_id = NEW.workspace_id
           AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'sandbox % scope chain broken: workspace % does not belong to client %',
            NEW.sandbox_id, NEW.workspace_id, NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandboxes_scope_chain_trigger ON sandboxes;
CREATE TRIGGER sandboxes_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON sandboxes
    FOR EACH ROW EXECUTE FUNCTION sandboxes_scope_chain();

-- ---------------------------------------------------------------------------
-- THE TEARDOWN GATE: a sandbox cannot enter ANY teardown state (releasing,
-- cancelled, released) while an ACTIVE lease controls it. Leases are released
-- first — by their owning execution, or through the deterministic stale-lease
-- reclamation — and only then is the environment torn down. The gate applies
-- to every teardown entry edge (ready → releasing, ready → cancelled,
-- preparing → cancelled, releasing → released, cancelled → released) so the
-- invariant holds under direct SQL rewrites too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sandboxes_release_gate() RETURNS trigger AS $$
BEGIN
    IF NEW.status <> OLD.status
       AND NEW.status IN ('releasing', 'cancelled', 'released')
       AND EXISTS (
           SELECT 1 FROM execution_sandbox_leases l
            WHERE l.sandbox_id = NEW.sandbox_id::text
              AND l.status = 'active'
       ) THEN
        RAISE EXCEPTION 'sandbox % cannot enter % while an active lease controls it; release the lease first',
            NEW.sandbox_id, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sandboxes_release_gate_trigger ON sandboxes;
CREATE TRIGGER sandboxes_release_gate_trigger
    BEFORE UPDATE ON sandboxes
    FOR EACH ROW EXECUTE FUNCTION sandboxes_release_gate();

-- ---------------------------------------------------------------------------
-- Lease upgrades (execution_sandbox_leases, migration 011 — appended here;
-- migration 011 itself is checksummed-immutable on main):
--
--   * concurrency_contract recorded on the lease at acquisition (backfilled
--     'exclusive' — the invariant every pre-MKT-012 lease was created
--     under). The lease's contract is enforcement metadata derived from the
--     sandbox row, never caller-supplied;
--   * the one-active-lease-per-sandbox partial UNIQUE index is RESELECTED by
--     the sandbox's declared contract: at most one active lease per
--     EXCLUSIVE sandbox; a concurrent-safe sandbox may hold multiple active
--     leases ("unless its declared runtime contract explicitly permits safe
--     concurrent use" — state-machines-v1.2.md; "The database must enforce
--     the selected concurrency invariant" — tenant-runtime-v1.2.md). The
--     index keeps its name: it is still the v1.2 backstop against two
--     conflicting active controllers, now contract-aware;
--   * the SANDBOX CONTRACT trigger on lease INSERT validates the sandbox
--     side: the sandbox exists, is READY, shares the lease's client and
--     workspace ("Cross-client sharing is forbidden"), matches the
--     execution's declared runtime class, and the lease records the
--     sandbox's concurrency contract;
--   * the lease's concurrency contract is immutable after acquisition.
-- ---------------------------------------------------------------------------

ALTER TABLE execution_sandbox_leases
    ADD COLUMN IF NOT EXISTS concurrency_contract text NOT NULL DEFAULT 'exclusive'
    CHECK (concurrency_contract IN ('exclusive', 'concurrent-safe'));

DROP INDEX IF EXISTS execution_sandbox_leases_one_active_per_sandbox;
CREATE UNIQUE INDEX execution_sandbox_leases_one_active_per_sandbox
    ON execution_sandbox_leases (sandbox_id)
    WHERE status = 'active' AND concurrency_contract = 'exclusive';

CREATE OR REPLACE FUNCTION execution_sandbox_leases_sandbox_contract() RETURNS trigger AS $$
DECLARE
    v_sandbox        RECORD;
    v_runtime_class  text;
BEGIN
    IF NEW.sandbox_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'sandbox % is not a valid sandbox identifier; a lease references a provisioned sandbox',
            NEW.sandbox_id;
    END IF;
    SELECT sandbox_id, client_id, workspace_id, runtime_class, status, concurrency_contract
      INTO v_sandbox
      FROM sandboxes
     WHERE sandbox_id = NEW.sandbox_id::uuid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'sandbox % does not exist; a lease references a provisioned sandbox',
            NEW.sandbox_id;
    END IF;
    IF v_sandbox.status <> 'ready' THEN
        RAISE EXCEPTION 'sandbox % is % (only a READY sandbox can be leased)',
            NEW.sandbox_id, v_sandbox.status;
    END IF;
    IF v_sandbox.client_id <> NEW.client_id OR v_sandbox.workspace_id <> NEW.workspace_id THEN
        RAISE EXCEPTION 'sandbox % belongs to workspace % of client %; cross-scope leasing is forbidden (lease claims workspace % of client %)',
            NEW.sandbox_id, v_sandbox.workspace_id, v_sandbox.client_id, NEW.workspace_id, NEW.client_id;
    END IF;
    SELECT e.runtime_class INTO v_runtime_class FROM executions e
     WHERE e.execution_id = NEW.execution_id;
    IF v_runtime_class IS NULL OR v_runtime_class <> v_sandbox.runtime_class THEN
        RAISE EXCEPTION 'sandbox % is of runtime class %; the execution must declare the same runtime class',
            NEW.sandbox_id, v_sandbox.runtime_class;
    END IF;
    IF NEW.concurrency_contract <> v_sandbox.concurrency_contract THEN
        RAISE EXCEPTION 'sandbox % declares concurrency contract %; the lease must record the sandbox''s declared contract',
            NEW.sandbox_id, v_sandbox.concurrency_contract;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_sandbox_leases_sandbox_contract_trigger ON execution_sandbox_leases;
CREATE TRIGGER execution_sandbox_leases_sandbox_contract_trigger
    BEFORE INSERT ON execution_sandbox_leases
    FOR EACH ROW EXECUTE FUNCTION execution_sandbox_leases_sandbox_contract();

CREATE OR REPLACE FUNCTION execution_sandbox_leases_contract_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.concurrency_contract <> OLD.concurrency_contract THEN
        RAISE EXCEPTION 'sandbox lease % concurrency contract is recorded at acquisition and immutable',
            OLD.sandbox_lease_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_sandbox_leases_contract_immutable_trigger ON execution_sandbox_leases;
CREATE TRIGGER execution_sandbox_leases_contract_immutable_trigger
    BEFORE UPDATE ON execution_sandbox_leases
    FOR EACH ROW EXECUTE FUNCTION execution_sandbox_leases_contract_immutable();
