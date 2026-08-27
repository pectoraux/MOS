-- MKT-009 Workflow instance state machine schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): "Workflow definition + instance state → /workflows". MKT-008
-- delivered the DEFINITION sub-authority; this migration delivers the
-- INSTANCE sub-authority — nothing here is an Execution (that is /executions,
-- MKT-010) and nothing here executes anything.
--
-- Frozen semantics encoded here (spec/implementation-contract.md §5
-- "Workflow instance state machine"; spec/state-machines.md "Workflow
-- Instance"; work-items.md MKT-009 "one deterministic lifecycle authority
-- for Workflow instances"; WF-AC-01..03):
--   * a Workflow INSTANCE pins ONE immutable Workflow Definition through the
--     EXPLICIT version reference (workflow_definition_id — the exact
--     workflow_definition_id a Deployment/instance pins; there is no
--     floating "latest" resolution anywhere). The database itself rejects:
--       - a definition that belongs to a DIFFERENT workflow, or
--       - a definition that is not ACTIVE at instance creation
--     so an instance can only ever rest on an activated, hence
--     content-frozen, definition version (activation freezes content; the
--     single active → retired retirement preserves content byte for byte);
--   * instance identity, the pinned definition, the owning Workflow and the
--     server-derived Workspace/Client/Agency scope are IMMUTABLE (trigger)
--     — an instance can never cross the Workflow or tenant boundary and can
--     never float to a different definition version;
--   * the scope-chain trigger rejects a workspace outside the recorded
--     Client and a client outside the recorded Agency on INSERT and UPDATE
--     (same backstop as workflows/workflow_definitions);
--   * status is the FROZEN §5 instance state machine
--     (draft|ready|running|paused|blocked|succeeded|failed|cancelled) and
--     the database itself enforces the frozen transition table
--     (draft→ready; ready→running; running→{paused, blocked, succeeded,
--     failed, cancelled}; paused→running; blocked→running — and NOTHING
--     else): illegal transitions, self-loops and every transition out of a
--     TERMINAL state (succeeded/failed/cancelled) are rejected by the
--     database even if every application check were bypassed ("terminal
--     states are immutable");
--   * every applied transition is recorded APPEND-ONLY in
--     workflow_instance_transitions together with the request's
--     idempotency key; (workflow_instance_id, idempotency_key) is
--     UNIQUE-fenced, which is the §5 storage end of "duplicate transition
--     requests are idempotent" — a replayed request converges to the
--     recorded transition instead of re-applying; the history rows reject
--     UPDATE and DELETE (append-only);
--   * every mutable instance row carries a version CAS token (§5:
--     "transitions use CAS/version checks"; §3 conventions).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns: instance authorization stays exactly the
-- /agencies membership authority composed with canonical owner resolution
-- (/workflows → /workspaces → /clients → /agencies) — no second tenant,
-- permission, execution or deployment authority. No input/output payload
-- columns, no node-instance state, no task rows: consuming the definition's
-- input schema and producing node work is EXECUTION semantics (/executions,
-- MKT-010+), deliberately absent here.

CREATE TABLE IF NOT EXISTS workflow_instances (
    workflow_instance_id    uuid        PRIMARY KEY,
    workflow_id             uuid        NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
    -- The EXPLICIT pinned version reference. No ON DELETE CASCADE: an
    -- existing instance PROTECTS its pinned definition row — the immutable
    -- content the instance rests on cannot be deleted underneath it.
    workflow_definition_id  uuid        NOT NULL REFERENCES workflow_definitions(workflow_definition_id),
    workspace_id            uuid        NOT NULL REFERENCES workspaces(workspace_id),
    client_id               uuid        NOT NULL REFERENCES clients(client_id),
    agency_id               uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    status                  text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'ready', 'running', 'paused', 'blocked',
                                              'succeeded', 'failed', 'cancelled')),
    created_by              uuid        REFERENCES users(user_id),
    version                 bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Listing surface: the instances of one Workflow (every state — terminal
-- history stays visible business record, exactly like definition history).
CREATE INDEX IF NOT EXISTS workflow_instances_workflow_idx
    ON workflow_instances (workflow_id, created_at, workflow_instance_id);

-- The append-only transition history: one row per APPLIED transition, with
-- the request idempotency key that fenced it.
CREATE TABLE IF NOT EXISTS workflow_instance_transitions (
    transition_id         uuid        PRIMARY KEY,
    workflow_instance_id  uuid        NOT NULL REFERENCES workflow_instances(workflow_instance_id) ON DELETE CASCADE,
    idempotency_key       text        NOT NULL CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    from_status           text        NOT NULL
                          CHECK (from_status IN ('draft', 'ready', 'running', 'paused', 'blocked',
                                                 'succeeded', 'failed', 'cancelled')),
    to_status             text        NOT NULL
                          CHECK (to_status IN ('draft', 'ready', 'running', 'paused', 'blocked',
                                               'succeeded', 'failed', 'cancelled')),
    reason                text        NOT NULL DEFAULT '',
    created_by            uuid        REFERENCES users(user_id),
    created_at            timestamptz NOT NULL DEFAULT now(),
    -- The §5 idempotency fence: within one instance a request idempotency
    -- key resolves to at most ONE applied transition — replayed duplicate
    -- transition requests converge to the recorded row.
    CONSTRAINT workflow_instance_transitions_key_unique
        UNIQUE (workflow_instance_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS workflow_instance_transitions_instance_idx
    ON workflow_instance_transitions (workflow_instance_id, created_at, transition_id);

-- The FROZEN §5 transition table as a predicate function (single source of
-- truth shared by the instance-row trigger and the history-insert trigger):
--   draft → ready
--   ready → running
--   running → paused | blocked | succeeded | failed | cancelled
--   paused → running
--   blocked → running
-- and NOTHING else. No self-loops; no skip-edges; the three terminal states
-- have no outgoing transitions ("terminal states are immutable").
CREATE OR REPLACE FUNCTION workflow_instance_transition_legal(from_status text, to_status text)
RETURNS boolean AS $$
BEGIN
    RETURN (
        (from_status = 'draft' AND to_status = 'ready')
        OR (from_status = 'ready' AND to_status = 'running')
        OR (from_status = 'running' AND to_status IN ('paused', 'blocked', 'succeeded', 'failed', 'cancelled'))
        OR (from_status = 'paused' AND to_status = 'running')
        OR (from_status = 'blocked' AND to_status = 'running')
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- State-machine backstop: the database itself rejects every illegal status
-- change on a workflow instance — illegal transitions, self-loops, and any
-- change (status or otherwise) to a TERMINAL instance (succeeded/failed/
-- cancelled rows are fully frozen history). Even a direct SQL rewrite
-- cannot move an instance outside the frozen §5 machine.
CREATE OR REPLACE FUNCTION workflow_instances_frozen_state_machine() RETURNS trigger AS $$
BEGIN
    IF NOT workflow_instance_transition_legal(OLD.status, NEW.status) THEN
        IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
            RAISE EXCEPTION 'workflow instance % is % (terminal) and frozen: terminal states are immutable',
                OLD.workflow_instance_id, OLD.status;
        END IF;
        IF OLD.status = NEW.status THEN
            RAISE EXCEPTION 'workflow instance % self-transition % → % is illegal (no self-loops in the frozen state machine)',
                OLD.workflow_instance_id, OLD.status, NEW.status;
        END IF;
        RAISE EXCEPTION 'illegal workflow instance transition % → % (frozen §5 state machine)',
            OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instances_frozen_state_machine_trigger ON workflow_instances;
CREATE TRIGGER workflow_instances_frozen_state_machine_trigger
    BEFORE UPDATE ON workflow_instances
    FOR EACH ROW EXECUTE FUNCTION workflow_instances_frozen_state_machine();

-- Immutability backstop (implementation-contract §3): instance identity,
-- the pinned definition version reference, the owning Workflow and the
-- server-derived Client/Agency/Workspace scope can NEVER be reassigned
-- through ANY mutation path — an instance cannot float to another
-- definition version and can never cross the Workflow or tenant boundary.
CREATE OR REPLACE FUNCTION workflow_instances_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.workflow_instance_id <> OLD.workflow_instance_id THEN
        RAISE EXCEPTION 'workflow_instance_id % is immutable', OLD.workflow_instance_id;
    END IF;
    IF NEW.workflow_id <> OLD.workflow_id THEN
        RAISE EXCEPTION 'workflow instance % cannot change workflow ownership (was workflow %)',
            OLD.workflow_instance_id, OLD.workflow_id;
    END IF;
    IF NEW.workflow_definition_id <> OLD.workflow_definition_id THEN
        RAISE EXCEPTION 'workflow instance % definition reference is immutable (was definition %) — there is no floating version resolution',
            OLD.workflow_instance_id, OLD.workflow_definition_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'workflow instance % cannot change Workspace scope (was workspace %)',
            OLD.workflow_instance_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'workflow instance % Client ownership is immutable (was client %)',
            OLD.workflow_instance_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'workflow instance % cannot change Agency ownership (was agency %)',
            OLD.workflow_instance_id, OLD.agency_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'workflow instance % provenance is immutable', OLD.workflow_instance_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instances_identity_immutable_trigger ON workflow_instances;
CREATE TRIGGER workflow_instances_identity_immutable_trigger
    BEFORE UPDATE ON workflow_instances
    FOR EACH ROW EXECUTE FUNCTION workflow_instances_identity_immutable();

-- Scope backstop (same posture as workflows): an instance's Client must be
-- the Client that owns the recorded Workspace, and its Agency must be the
-- Agency that owns that Client — enforced on INSERT and UPDATE, so the
-- scope chain (Agency → Client → Workspace → Workflow → Instance) cannot be
-- crossed through any column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION workflow_instances_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'workflow instance % workspace % does not belong to client %',
            NEW.workflow_instance_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'workflow instance % client % does not belong to agency %',
            NEW.workflow_instance_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instances_scope_chain_trigger ON workflow_instances;
CREATE TRIGGER workflow_instances_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON workflow_instances
    FOR EACH ROW EXECUTE FUNCTION workflow_instances_scope_chain();

-- Definition-pin backstop: an instance can only ever be created pinning an
-- ACTIVE definition OF THE SAME WORKFLOW. Active definitions are
-- content-immutable ("immutable after activation") and retirement preserves
-- content byte for byte, so a pinned reference is stable forever; draft and
-- review definitions are still CAS-editable (pinning them would float), and
-- retired definitions record ended versions (no new use). The database
-- itself rejects every other combination, so the explicit-version contract
-- cannot be bypassed through the instance table.
CREATE OR REPLACE FUNCTION workflow_instances_active_definition() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workflow_definitions wd
        WHERE wd.workflow_definition_id = NEW.workflow_definition_id
          AND wd.workflow_id = NEW.workflow_id
          AND wd.status = 'active'
    ) THEN
        RAISE EXCEPTION 'workflow instance % must pin an ACTIVE workflow definition of workflow % (pinned %)',
            NEW.workflow_instance_id, NEW.workflow_id, NEW.workflow_definition_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instances_active_definition_trigger ON workflow_instances;
CREATE TRIGGER workflow_instances_active_definition_trigger
    BEFORE INSERT ON workflow_instances
    FOR EACH ROW EXECUTE FUNCTION workflow_instances_active_definition();

-- History legality backstop: only a legal frozen-§5 pair can be RECORDED
-- as a transition row (defense in depth — the row history can never claim
-- an illegal transition even if written by direct SQL).
CREATE OR REPLACE FUNCTION workflow_instance_transitions_legal() RETURNS trigger AS $$
BEGIN
    IF NOT workflow_instance_transition_legal(NEW.from_status, NEW.to_status) THEN
        RAISE EXCEPTION 'illegal workflow instance transition % → % cannot be recorded',
            NEW.from_status, NEW.to_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instance_transitions_legal_trigger ON workflow_instance_transitions;
CREATE TRIGGER workflow_instance_transitions_legal_trigger
    BEFORE INSERT ON workflow_instance_transitions
    FOR EACH ROW EXECUTE FUNCTION workflow_instance_transitions_legal();

-- Append-only backstop: applied-transition history is immutable evidence —
-- UPDATE and DELETE are both rejected by the database itself.
CREATE OR REPLACE FUNCTION workflow_instance_transitions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'workflow instance transitions are append-only history (% blocked)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instance_transitions_append_only_trigger ON workflow_instance_transitions;
CREATE TRIGGER workflow_instance_transitions_append_only_trigger
    BEFORE UPDATE OR DELETE ON workflow_instance_transitions
    FOR EACH ROW EXECUTE FUNCTION workflow_instance_transitions_append_only();
