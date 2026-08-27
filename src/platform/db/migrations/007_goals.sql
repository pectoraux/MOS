-- MKT-006 Goals domain schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   goals → /goals (Goal lifecycle)
--
-- Frozen semantics encoded here (spec/architecture.md §7 "Goal is the
-- top-level unit of business intent"; spec/tenant-runtime-model.md ownership
-- matrix: "Goal | Client | business-intent object"; GOAL-001):
--   * Goal identity (goal_id) is server-generated, immutable and NEVER
--     reassignable — enforced by trigger, not just API discipline;
--   * Client ownership (client_id) is NOT NULL and IMMUTABLE: a Goal is a
--     Client-scoped business-intent object and can NEVER cross the hard
--     tenant boundary (GOAL-AC-02 "goal cannot silently execute outside
--     authorized Client scope" — the scope itself is un-movable);
--   * Workspace scope (workspace_id) is an OPTIONAL organizational
--     refinement INSIDE the owning Client: NULL = client-wide goal. It is
--     immutable once set (scope is durable identity — re-scoping requires a
--     NEW goal, never a silent migration), and the database itself rejects a
--     workspace that does not belong to the goal's Client (trigger), so the
--     Client boundary cannot be crossed through the workspace column either;
--   * success_criteria is a NON-EMPTY jsonb array (CHECK): a Goal cannot be
--     persisted without measurable success criteria (GOAL-AC-01). Each
--     criterion is validated by the /goals module to bind a named metric to
--     a numeric target through an explicit comparator — measurability is
--     structural, not prose;
--   * metrics / constraints are jsonb arrays (additional observed metrics,
--     resource/risk/time/other constraints — architecture.md §7);
--   * time_horizon is an optional jsonb object {startsOn, endsOn}
--     (architecture.md §7 "time horizon");
--   * Goal lifecycle is draft/active/achieved/abandoned. achieved/abandoned
--     are TERMINAL and a terminal row rejects EVERY update (trigger) —
--     business history is append-oriented and can never be rewritten
--     (implementation-contract §3 conventions; AGENTS.md append-oriented
--     records). `draft → active` is the activation edge; there is NO
--     execution semantics here: a Goal is not a workflow (architecture.md
--     §7 "Goal is not a workflow") and /goals owns no workflow/playbook/
--     execution state (frozen authority map);
--   * provenance (created_by/created_at) is immutable history; ownership is
--     server-derived (the caller can never inject it);
--   * version CAS for concurrent mutation (row-locked transitions).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns: Goal authorization stays exactly the
-- /agencies membership authority composed with /clients canonical owner
-- resolution (and /workspaces canonical ownership for the optional scope) —
-- no second tenant/permission/workflow/execution authority.

CREATE TABLE IF NOT EXISTS goals (
    goal_id            uuid        PRIMARY KEY,
    client_id          uuid        NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    workspace_id       uuid        REFERENCES workspaces(workspace_id),
    objective          text        NOT NULL,
    success_criteria   jsonb       NOT NULL CHECK (jsonb_typeof(success_criteria) = 'array'
                                              AND jsonb_array_length(success_criteria) >= 1),
    metrics            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(metrics) = 'array'),
    constraints        jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints) = 'array'),
    time_horizon       jsonb       CHECK (time_horizon IS NULL OR jsonb_typeof(time_horizon) = 'object'),
    status             text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'achieved', 'abandoned')),
    created_by         uuid        REFERENCES users(user_id),
    version            bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Listing surfaces: goals of one Client (all lifecycle states — terminal
-- goals are visible business history, not tombstones), and the goals scoped
-- to one Workspace. No uniqueness fence: two Goals may legitimately carry
-- the same objective/criteria (append-oriented business records; concurrent
-- creation is serialized by identity, not by content).
CREATE INDEX IF NOT EXISTS goals_client_idx
    ON goals (client_id, created_at, goal_id);

CREATE INDEX IF NOT EXISTS goals_workspace_idx
    ON goals (workspace_id) WHERE workspace_id IS NOT NULL;

-- Immutability backstop (implementation-contract §3, GOAL-AC-02): Goal
-- identity, Client ownership, Workspace scope and provenance can NEVER be
-- reassigned through ANY ordinary mutation path — the database itself
-- rejects the update. A Goal can never cross the Client boundary, and its
-- Workspace scope can never migrate (including NULL ⇄ set).
CREATE OR REPLACE FUNCTION goals_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.goal_id <> OLD.goal_id THEN
        RAISE EXCEPTION 'goal_id % is immutable', OLD.goal_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'goal % cannot change Client ownership (was client %)',
            OLD.goal_id, OLD.client_id;
    END IF;
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
        RAISE EXCEPTION 'goal % Workspace scope is immutable once set (was %)',
            OLD.goal_id, COALESCE(OLD.workspace_id::text, 'client-wide');
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'goal % provenance is immutable', OLD.goal_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goals_identity_immutable_trigger ON goals;
CREATE TRIGGER goals_identity_immutable_trigger
    BEFORE UPDATE ON goals
    FOR EACH ROW EXECUTE FUNCTION goals_identity_immutable();

-- Lifecycle backstop: terminal Goals (achieved/abandoned) are frozen
-- business history — every content-changing UPDATE is rejected, so stale
-- identifiers can never rewrite what a concluded Goal recorded (a pure
-- no-op row write stays legal and changes nothing).
CREATE OR REPLACE FUNCTION goals_terminal_frozen() RETURNS trigger AS $$
BEGIN
    IF OLD.status IN ('achieved', 'abandoned') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
        RAISE EXCEPTION 'goal % is % and frozen: business history is append-only',
            OLD.goal_id, OLD.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goals_terminal_frozen_trigger ON goals;
CREATE TRIGGER goals_terminal_frozen_trigger
    BEFORE UPDATE ON goals
    FOR EACH ROW EXECUTE FUNCTION goals_terminal_frozen();

-- Scope backstop (GOAL-AC-02 at the storage layer): a workspace-scoped Goal
-- must reference a Workspace of the SAME Client — the database itself
-- rejects a cross-Client workspace on INSERT and on UPDATE, so the Client
-- boundary cannot be crossed through the workspace column even if every
-- application check were bypassed.
CREATE OR REPLACE FUNCTION goals_workspace_within_client() RETURNS trigger AS $$
BEGIN
    IF NEW.workspace_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM workspaces w
            WHERE w.workspace_id = NEW.workspace_id AND w.client_id = NEW.client_id
        ) THEN
            RAISE EXCEPTION 'goal % workspace % does not belong to client %',
                NEW.goal_id, NEW.workspace_id, NEW.client_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goals_workspace_within_client_trigger ON goals;
CREATE TRIGGER goals_workspace_within_client_trigger
    BEFORE INSERT OR UPDATE ON goals
    FOR EACH ROW EXECUTE FUNCTION goals_workspace_within_client();
