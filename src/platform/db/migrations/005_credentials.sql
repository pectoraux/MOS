-- MKT-005 Credential reference schema (CRED-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   credential_references → /credentials (Credential references)
--
-- Frozen semantics encoded here (spec/implementation-contract.md §21
-- "Credential contract"; issue #13 MKT-005-AC-05):
--   * Domain records store credential REFERENCES, never secret material:
--     this table has NO column capable of carrying material — only an
--     opaque backend handle (secret_handle) that resolves EXCLUSIVELY
--     through the platform SecretStore port inside an authorized
--     server-side context;
--   * credential identity (credential_id) is server-generated, immutable
--     and NEVER reassignable — enforced by trigger, not just API discipline;
--   * scope (agency_id, and the optional client_id narrowing) is IMMUTABLE:
--     a credential reference can never be silently re-scoped to another
--     tenant — re-scoping requires a NEW reference (old one deleted);
--   * secret_handle is IMMUTABLE: a reference can never be silently
--     re-bound to different secret material;
--   * provenance (created_by/created_at) is immutable history;
--   * lifecycle is active/disabled/deleted with `deleted` TERMINAL (DB
--     trigger) — a deleted reference is a tombstone that can never be
--     replayed back to life;
--   * the (agency_id, label) pair is unique among LIVE references (partial
--     unique index) — per-agency human handle uniqueness, race-free under
--     concurrent creation; a deleted reference's label may be reused by a
--     NEW identity;
--   * agency membership/role authorization stays exactly the /agencies
--     authority (dependency matrix /credentials ──→ /auth, /policies):
--     no owner/role/user columns live here.
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.

CREATE TABLE IF NOT EXISTS credential_references (
    credential_id uuid        PRIMARY KEY,
    agency_id     uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    client_id     uuid        REFERENCES clients(client_id) ON DELETE CASCADE,
    kind          text        NOT NULL,
    label         text        NOT NULL,
    secret_handle text        NOT NULL,
    status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
    created_by    uuid        REFERENCES users(user_id),
    version       bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-agency label fence (issue #13 data/security contract): uniqueness is
-- per-AGENCY; deleted tombstones do not block a new reference with the same
-- label.
CREATE UNIQUE INDEX IF NOT EXISTS credential_references_agency_label_fence
    ON credential_references (agency_id, label) WHERE status IN ('active', 'disabled');

CREATE INDEX IF NOT EXISTS credential_references_agency_live_idx
    ON credential_references (agency_id) WHERE status <> 'deleted';

-- Immutability backstop (issue #13: "Credential references are isolated
-- from secret material" + scope immutability): identity, tenant scope,
-- backend handle and provenance can NEVER be reassigned through ANY
-- ordinary mutation path — the database itself rejects the update. A
-- reference can never cross the Agency boundary, be narrowed/moved to a
-- different Client, or be re-bound to different material.
CREATE OR REPLACE FUNCTION credential_references_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.credential_id <> OLD.credential_id THEN
        RAISE EXCEPTION 'credential_id % is immutable', OLD.credential_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'credential % cannot change Agency ownership (was agency %)',
            OLD.credential_id, OLD.agency_id;
    END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        RAISE EXCEPTION 'credential % cannot change Client scope (was client %)',
            OLD.credential_id, OLD.client_id;
    END IF;
    IF NEW.secret_handle <> OLD.secret_handle THEN
        RAISE EXCEPTION 'credential % cannot be re-bound to different secret material', OLD.credential_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'credential % provenance is immutable', OLD.credential_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credential_references_identity_immutable_trigger ON credential_references;
CREATE TRIGGER credential_references_identity_immutable_trigger
    BEFORE UPDATE ON credential_references
    FOR EACH ROW EXECUTE FUNCTION credential_references_identity_immutable();

-- Lifecycle backstop: deleted credential references are terminal
-- tombstones; they can never silently come back to life via UPDATE.
CREATE OR REPLACE FUNCTION credential_references_deleted_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
        RAISE EXCEPTION 'credential % is deleted and terminal', OLD.credential_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credential_references_deleted_terminal_trigger ON credential_references;
CREATE TRIGGER credential_references_deleted_terminal_trigger
    BEFORE UPDATE ON credential_references
    FOR EACH ROW EXECUTE FUNCTION credential_references_deleted_terminal();
