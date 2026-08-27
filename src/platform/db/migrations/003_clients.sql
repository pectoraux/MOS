-- MKT-003 Client tenancy and hard isolation schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   clients → /clients (Client ownership/isolation — the HARD business-data
--                        security boundary inside an Agency)
--
-- Frozen semantics encoded here (spec/tenant-runtime-model.md ownership matrix:
-- "Client | Agency | hard data/security tenant", architecture.md §2 "Client is
-- the hard security/data boundary"):
--   * an Agency can own multiple Clients (no uniqueness on agency_id alone);
--   * Client identity (client_id) is server-generated, immutable, and NEVER
--     reassignable — enforced by trigger, not just by API discipline;
--   * Agency→Client ownership (agency_id) is IMMUTABLE: a Client can never be
--     moved between Agencies (re-parenting would silently migrate the tenant
--     boundary — TENANT-AC-02);
--   * provenance (created_by/created_at) is immutable history;
--   * Client lifecycle is active/disabled/deleted with `deleted` TERMINAL
--     (DB trigger) — a deleted Client is a tombstone: its identifiers can
--     never be resurrected by replay (issue #9 security contract);
--   * the (agency_id, slug) pair is unique among LIVE clients (partial unique
--     index) — per-tenant uniqueness, race-free under concurrent creation;
--     a deleted Client's slug may be reused by a NEW Client identity;
--   * no owner/role/user columns: Client ownership is exactly the agency_id
--     foreign key (role assignment stays in agency_memberships — MKT-002).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.

CREATE TABLE IF NOT EXISTS clients (
    client_id   uuid        PRIMARY KEY,
    agency_id   uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    name        text        NOT NULL,
    slug        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
    created_by  uuid        REFERENCES users(user_id),
    version     bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Tenant fence (issue #9 concurrency contract): Client identity/Agency
-- ownership uniqueness is DB-fenced. Uniqueness is per-AGENCY (two Agencies
-- may each own a Client with the same slug); deleted tombstones do not block
-- a new Client with the same slug (distinct immutable identity).
CREATE UNIQUE INDEX IF NOT EXISTS clients_agency_slug_fence
    ON clients (agency_id, slug) WHERE status IN ('active', 'disabled');

CREATE INDEX IF NOT EXISTS clients_agency_live_idx
    ON clients (agency_id) WHERE status <> 'deleted';

-- Immutability backstop (TENANT-AC-02): Client identity, Agency ownership and
-- provenance can NEVER be reassigned through ANY ordinary mutation path —
-- the database itself rejects the update.
CREATE OR REPLACE FUNCTION clients_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.client_id <> OLD.client_id THEN
        RAISE EXCEPTION 'client_id % is immutable', OLD.client_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'client % cannot change Agency ownership (was agency %)',
            OLD.client_id, OLD.agency_id;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'client % provenance is immutable', OLD.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_identity_immutable_trigger ON clients;
CREATE TRIGGER clients_identity_immutable_trigger
    BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION clients_identity_immutable();

-- Lifecycle backstop: deleted Clients are terminal tombstones; they can never
-- silently come back to life via UPDATE (issue #9: "deleted/revoked
-- relationships cannot be resurrected by replaying stale identifiers").
CREATE OR REPLACE FUNCTION clients_deleted_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
        RAISE EXCEPTION 'client % is deleted and terminal', OLD.client_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_deleted_terminal_trigger ON clients;
CREATE TRIGGER clients_deleted_terminal_trigger
    BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION clients_deleted_terminal();
