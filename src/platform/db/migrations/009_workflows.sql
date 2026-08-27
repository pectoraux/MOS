-- MKT-008 Workflow graph model schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   workflows, workflow_definitions → /workflows (Workflow definition +
--   instance state; MKT-008 delivers the DEFINITION sub-authority only —
--   instance lifecycle is MKT-009)
--
-- Frozen semantics encoded here (spec/implementation-contract.md §4
-- "Workflow definition contract"; spec/architecture.md §10 "Workflow Graph";
-- tenant-runtime-model.md ownership matrix "Workflow | Workspace/Client |
-- execution authority"; WF-001 "Implement one deterministic Workflow Graph
-- authority with typed node/edge contracts"):
--   * Workflow identity (workflow_id) is server-generated, immutable and
--     NEVER reassignable — enforced by trigger, not just API discipline;
--   * a Workflow is WORKSPACE-scoped (the scope chain: Agency → Client →
--     Workspace → … → Workflow): workspace_id is NOT NULL and IMMUTABLE, and
--     the Client (client_id) and Agency (agency_id) ownership are
--     SERVER-DERIVED from the canonical Workspace owner at creation — the
--     database itself rejects a workspace outside the recorded Client and a
--     client outside the recorded Agency (triggers), so the boundary cannot
--     be crossed through any column even if every application check were
--     bypassed;
--   * the versioned unit is the WORKFLOW DEFINITION (implementation-contract
--     §4: "A Workflow Definition is versioned and immutable after
--     activation. It contains: workflow_definition_id; version;
--     workspace/client owner; optional playbook_version reference; node
--     definitions; edge definitions; input schema; output schema; retry
--     policy defaults; concurrency limits; timeout policy; compensation
--     declarations where supported; activation state."):
--       - workflow_definition_id is the opaque EXPLICIT version reference a
--         future Deployment/Workflow-instance pins (marketing-cloud-
--         deployment-v1.4.md: "references immutable Playbook/Workflow
--         versions"); version_number is the per-workflow monotonic ordinal;
--         both are IMMUTABLE and (workflow_id, version_number) is
--         UNIQUE-fenced — a version number is assigned exactly once per
--         workflow;
--       - the optional playbook_version_id is the "Playbook → Workflow
--         provenance" link (the strategy artifact this graph was produced
--         FROM — implementation-clarifications-v1.2): immutable once set,
--         and confined by the database to playbook versions whose scope is
--         compatible (Agency-scoped reusable IP, or the SAME Client that
--         owns this workflow) — the Client boundary cannot be crossed
--         through the playbook column;
--       - graph (nodes + edges), input_schema and output_schema are jsonb
--         objects fully validated by the /workflows module authority
--         (typed node contracts, edge legality, join semantics, explicit
--         bounded loops, cycle rejection, resolved schema mappings — the
--         frozen §4 validation MUST list); the database CHECKs guarantee
--         the top-level jsonb shape so a row can never hold a non-object
--         graph or schema;
--       - retry_policy_defaults, concurrency_limits, timeout_policy and
--         compensation are the declarative §4 policy blocks — stored
--         structurally, INTERPRETED only by the future runtime (MKT-009+);
--       - status is the ACTIVATION STATE (§4): draft|review|active|retired.
--         ACTIVATED definitions are IMMUTABLE — the database itself rejects
--         any content change to an active definition, the single legal
--         transition out of `active` being the content-preserving
--         `active → retired`, and RETIRED rows are fully frozen terminal
--         history ("immutable deployed definitions", work-items.md MKT-008);
--   * there is deliberately NO instance/runtime state here: no run, no
--     instance table, no RUNNING/PAUSED/QUEUED columns — the Workflow
--     INSTANCE state machine (DRAFT → READY → RUNNING → …) is the MKT-009
--     /workflows extension, not the definition model;
--   * provenance (created_by/created_at) is immutable history; ownership is
--     server-derived (the caller can never inject it);
--   * version CAS on both tables for concurrent mutation (row-locked
--     transitions).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns: Workflow authorization stays exactly the
-- /agencies membership authority composed with canonical owner resolution
-- (/workspaces → /clients → /agencies) — no second tenant/permission/
-- execution/deployment authority.

CREATE TABLE IF NOT EXISTS workflows (
    workflow_id       uuid        PRIMARY KEY,
    workspace_id      uuid        NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    client_id         uuid        NOT NULL REFERENCES clients(client_id),
    agency_id         uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    name              text        NOT NULL,
    description       text        NOT NULL DEFAULT '',
    created_by        uuid        REFERENCES users(user_id),
    version           bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
    workflow_definition_id  uuid        PRIMARY KEY,
    workflow_id             uuid        NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
    version_number          integer     NOT NULL CHECK (version_number >= 1),
    status                  text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'active', 'retired')),
    playbook_version_id     uuid        REFERENCES playbook_versions(version_id),
    graph                   jsonb       NOT NULL CHECK (jsonb_typeof(graph) = 'object'),
    input_schema            jsonb       NOT NULL CHECK (jsonb_typeof(input_schema) = 'object'),
    output_schema           jsonb       NOT NULL CHECK (jsonb_typeof(output_schema) = 'object'),
    retry_policy_defaults   jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(retry_policy_defaults) = 'object'),
    concurrency_limits      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(concurrency_limits) = 'object'),
    timeout_policy          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(timeout_policy) = 'object'),
    compensation            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(compensation) = 'array'),
    created_by              uuid        REFERENCES users(user_id),
    version                 bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    -- The EXPLICIT version reference fence: within one workflow a version
    -- number is assigned exactly once and can never be duplicated or
    -- reassigned (the storage end of the explicit-version contract a
    -- Deployment pins).
    CONSTRAINT workflow_definitions_number_unique UNIQUE (workflow_id, version_number)
);

-- Listing surface: the workflows of one Workspace. No uniqueness fence on
-- names: workflows are append-oriented versioned artifacts, and concurrent
-- creation is serialized by identity, not by content.
CREATE INDEX IF NOT EXISTS workflows_workspace_idx
    ON workflows (workspace_id, created_at, workflow_id);

-- Immutability backstop (implementation-contract §3): Workflow identity,
-- Workspace scope and the server-derived Client/Agency ownership can NEVER
-- be reassigned through ANY ordinary mutation path — the database itself
-- rejects the update. A Workflow can never cross the Workspace, Client or
-- Agency boundary.
CREATE OR REPLACE FUNCTION workflows_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.workflow_id <> OLD.workflow_id THEN
        RAISE EXCEPTION 'workflow_id % is immutable', OLD.workflow_id;
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'workflow % cannot change Workspace scope (was workspace %)',
            OLD.workflow_id, OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'workflow % Client ownership is immutable (was client %)',
            OLD.workflow_id, OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'workflow % cannot change Agency ownership (was agency %)',
            OLD.workflow_id, OLD.agency_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'workflow % provenance is immutable', OLD.workflow_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflows_identity_immutable_trigger ON workflows;
CREATE TRIGGER workflows_identity_immutable_trigger
    BEFORE UPDATE ON workflows
    FOR EACH ROW EXECUTE FUNCTION workflows_identity_immutable();

-- Scope backstop: a Workflow's Client must be the Client that owns the
-- recorded Workspace, and its Agency must be the Agency that owns that
-- Client — the database itself rejects any drift on INSERT and on UPDATE,
-- so the scope chain (Agency → Client → Workspace → Workflow) cannot be
-- crossed through any column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION workflows_scope_chain() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.workspace_id = NEW.workspace_id
          AND w.client_id = NEW.client_id
    ) THEN
        RAISE EXCEPTION 'workflow % workspace % does not belong to client %',
            NEW.workflow_id, NEW.workspace_id, NEW.client_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM clients c
        WHERE c.client_id = NEW.client_id
          AND c.agency_id = NEW.agency_id
    ) THEN
        RAISE EXCEPTION 'workflow % client % does not belong to agency %',
            NEW.workflow_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflows_scope_chain_trigger ON workflows;
CREATE TRIGGER workflows_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON workflows
    FOR EACH ROW EXECUTE FUNCTION workflows_scope_chain();

-- Version identity backstop: the explicit version reference
-- (workflow_definition_id, workflow_id, version_number), the immutable
-- playbook provenance link and provenance can NEVER be reassigned — an
-- active or retired reference keeps pointing at exactly the content it was
-- created with, forever.
CREATE OR REPLACE FUNCTION workflow_definitions_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.workflow_definition_id <> OLD.workflow_definition_id THEN
        RAISE EXCEPTION 'workflow_definition_id % is immutable', OLD.workflow_definition_id;
    END IF;
    IF NEW.workflow_id <> OLD.workflow_id THEN
        RAISE EXCEPTION 'workflow definition % cannot change workflow ownership (was workflow %)',
            OLD.workflow_definition_id, OLD.workflow_id;
    END IF;
    IF NEW.version_number <> OLD.version_number THEN
        RAISE EXCEPTION 'workflow definition % number % is immutable',
            OLD.workflow_definition_id, OLD.version_number;
    END IF;
    IF NEW.playbook_version_id IS DISTINCT FROM OLD.playbook_version_id THEN
        RAISE EXCEPTION 'workflow definition % playbook provenance is immutable once set (was %)',
            OLD.workflow_definition_id, COALESCE(OLD.playbook_version_id::text, 'unlinked');
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'workflow definition % provenance is immutable', OLD.workflow_definition_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_definitions_identity_immutable_trigger ON workflow_definitions;
CREATE TRIGGER workflow_definitions_identity_immutable_trigger
    BEFORE UPDATE ON workflow_definitions
    FOR EACH ROW EXECUTE FUNCTION workflow_definitions_identity_immutable();

-- Playbook-provenance scope backstop ("Playbook → Workflow provenance"):
-- a linked playbook version must EXIST and be usable by this workflow's
-- Client — Agency-scoped reusable IP (playbook client NULL) or a playbook
-- of the SAME Client that owns the workflow. The database itself rejects a
-- cross-Client playbook link (or an unknown playbook version) on INSERT
-- and on UPDATE, so the Client boundary cannot be crossed through the
-- playbook column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION workflow_definitions_playbook_scope() RETURNS trigger AS $$
BEGIN
    IF NEW.playbook_version_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM playbook_versions pv
            JOIN playbooks p ON p.playbook_id = pv.playbook_id
            JOIN workflows wf ON wf.workflow_id = NEW.workflow_id
            WHERE pv.version_id = NEW.playbook_version_id
              AND (p.client_id IS NULL OR p.client_id = wf.client_id)
        ) THEN
            RAISE EXCEPTION 'workflow definition % playbook version % is not usable by this workflow client',
                NEW.workflow_definition_id, NEW.playbook_version_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_definitions_playbook_scope_trigger ON workflow_definitions;
CREATE TRIGGER workflow_definitions_playbook_scope_trigger
    BEFORE INSERT OR UPDATE ON workflow_definitions
    FOR EACH ROW EXECUTE FUNCTION workflow_definitions_playbook_scope();

-- Activation-immutability backstop (implementation-contract §4: "A Workflow
-- Definition is versioned and immutable after activation"): any content
-- change to an ACTIVE definition (graph, schemas, policy blocks, identity,
-- provenance) is rejected by the database itself; the single legal
-- transition out of `active` is the content-preserving `active → retired`
-- retirement, and RETIRED rows are fully frozen terminal history (a pure
-- no-op row write stays legal and changes nothing). Deployment "references
-- immutable Playbook/Workflow versions" (marketing-cloud-deployment-v1.4.md)
-- — this trigger is what makes that reference safe at the storage layer.
CREATE OR REPLACE FUNCTION workflow_definitions_active_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' THEN
        IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
            RAISE EXCEPTION 'workflow definition % is retired and frozen: version history is append-only',
                OLD.workflow_definition_id;
        END IF;
    ELSIF OLD.status = 'active' THEN
        IF NEW.status NOT IN ('active', 'retired') THEN
            RAISE EXCEPTION 'active workflow definition % can only transition to retired (attempted %)',
                OLD.workflow_definition_id, NEW.status;
        END IF;
        IF NEW.graph IS DISTINCT FROM OLD.graph
           OR NEW.input_schema IS DISTINCT FROM OLD.input_schema
           OR NEW.output_schema IS DISTINCT FROM OLD.output_schema
           OR NEW.retry_policy_defaults IS DISTINCT FROM OLD.retry_policy_defaults
           OR NEW.concurrency_limits IS DISTINCT FROM OLD.concurrency_limits
           OR NEW.timeout_policy IS DISTINCT FROM OLD.timeout_policy
           OR NEW.compensation IS DISTINCT FROM OLD.compensation THEN
            RAISE EXCEPTION 'active workflow definition % content is immutable (immutable after activation)',
                OLD.workflow_definition_id;
        END IF;
        IF NEW.workflow_id <> OLD.workflow_id
           OR NEW.version_number <> OLD.version_number
           OR NEW.playbook_version_id IS DISTINCT FROM OLD.playbook_version_id
           OR NEW.created_at <> OLD.created_at
           OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
            RAISE EXCEPTION 'active workflow definition % identity and provenance are immutable',
                OLD.workflow_definition_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_definitions_active_immutable_trigger ON workflow_definitions;
CREATE TRIGGER workflow_definitions_active_immutable_trigger
    BEFORE UPDATE ON workflow_definitions
    FOR EACH ROW EXECUTE FUNCTION workflow_definitions_active_immutable();
