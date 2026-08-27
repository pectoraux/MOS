-- MKT-004 Workspace boundary schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   workspaces → /workspaces (Workspace ownership)
--
-- Frozen semantics encoded here (spec/tenant-runtime-model.md ownership matrix:
-- "Workspace | Client | organizational boundary"; invariant 2: "Workspace IDs
-- never authorize access outside their Client"; architecture.md §2: the Client
-- remains the HARD security boundary — a Workspace NEVER weakens it):
--   * a Client can own multiple Workspaces (no uniqueness on client_id alone);
--   * Workspace identity (workspace_id) is server-generated, immutable and
--     NEVER reassignable — enforced by trigger, not just API discipline;
--   * Client→Workspace ownership (client_id) is IMMUTABLE: a Workspace can
--     never be moved between Clients — moving it would silently migrate the
--     workspace across the hard tenant boundary (issue #11 MKT-004-AC-01,
--     TENANT-AC-05 "Workspace cannot cross Client boundary");
--   * the Client→Workspace relationship lives HERE and nowhere else: no
--     workspace_id column is added to clients/agencies/users (issue #11
--     forbidden: "Client-to-Workspace relationship stored elsewhere as an
--     alternate authority");
--   * provenance (created_by/created_at) is immutable history;
--   * Workspace lifecycle is active/disabled/deleted with `deleted` TERMINAL
--     (DB trigger) — a deleted Workspace is a tombstone whose identifiers can
--     never be resurrected by replay (issue #11 MKT-004-AC-06);
--   * the (client_id, slug) pair is unique among LIVE workspaces (partial
--     unique index) — per-Client uniqueness, race-free under concurrent
--     creation; a deleted Workspace's slug may be reused by a NEW identity;
--   * no owner/role/user columns: Workspace authorization stays exactly the
--     /agencies membership authority composed with /clients canonical owner
--     resolution (issue #11 MKT-004-AC-08: no second tenant/permission/
--     workflow/execution authority).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.

CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id uuid        PRIMARY KEY,
    client_id    uuid        NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    name         text        NOT NULL,
    slug         text        NOT NULL,
    status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
    created_by   uuid        REFERENCES users(user_id),
    version      bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Tenant fence (issue #11 concurrency contract): Workspace identity/Client
-- ownership uniqueness is DB-fenced. Uniqueness is per-CLIENT (two Clients —
-- even inside the same Agency — may each own a Workspace with the same slug);
-- deleted tombstones do not block a new Workspace with the same slug.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_client_slug_fence
    ON workspaces (client_id, slug) WHERE status IN ('active', 'disabled');

CREATE INDEX IF NOT EXISTS workspaces_client_live_idx
    ON workspaces (client_id) WHERE status <> 'deleted';

-- Immutability backstop (issue #11 MKT-004-AC-01): Workspace identity, Client
-- ownership and provenance can NEVER be reassigned through ANY ordinary
-- mutation path — the database itself rejects the update. A Workspace can
-- never cross the Client boundary.
CREATE OR REPLACE FUNCTION workspaces_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.workspace_id <> OLD.workspace_id THEN
        RAISE EXCEPTION 'workspace_id % is immutable', OLD.workspace_id;
    END IF;
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'workspace % cannot change Client ownership (was client %)',
            OLD.workspace_id, OLD.client_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'workspace % provenance is immutable', OLD.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workspaces_identity_immutable_trigger ON workspaces;
CREATE TRIGGER workspaces_identity_immutable_trigger
    BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION workspaces_identity_immutable();

-- Lifecycle backstop: deleted Workspaces are terminal tombstones; they can
-- never silently come back to life via UPDATE (issue #11 MKT-004-AC-06:
-- "terminal/deleted state cannot be resurrected through stale identifiers").
CREATE OR REPLACE FUNCTION workspaces_deleted_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
        RAISE EXCEPTION 'workspace % is deleted and terminal', OLD.workspace_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workspaces_deleted_terminal_trigger ON workspaces;
CREATE TRIGGER workspaces_deleted_terminal_trigger
    BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION workspaces_deleted_terminal();
