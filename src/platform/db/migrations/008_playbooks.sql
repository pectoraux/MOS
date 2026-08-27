-- MKT-007 Playbooks and versioning schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   playbooks, playbook_versions → /playbooks (Playbook versions)
--
-- Frozen semantics encoded here (spec/architecture.md §8 "A Playbook is a
-- versioned, reusable set of strategy/workflow templates. A published
-- Playbook Version is immutable. Deployment references the exact Playbook
-- Version and does not mutate it."; spec/tenant-runtime-model.md ownership
-- matrix: "Playbook | Agency or Client | reusable operational IP";
-- PLAY-001 "Persist versioned Playbooks that can be deployed into Client
-- Workspaces"):
--   * Playbook identity (playbook_id) is server-generated, immutable and
--     NEVER reassignable — enforced by trigger, not just API discipline;
--   * Agency ownership (agency_id) is NOT NULL and IMMUTABLE: every
--     Playbook belongs to exactly one commercial tenant;
--   * Client scope (client_id) is the OPTIONAL hard-boundary refinement:
--     NULL = Agency-scoped reusable operational IP; set = Client-scoped.
--     It is IMMUTABLE once set (scope is durable identity — re-scoping
--     requires a NEW playbook, never a silent migration), and the database
--     itself rejects a client that does not belong to the playbook's Agency
--     (trigger), so the Agency boundary cannot be crossed through the
--     client column either;
--   * the optional Goal link (goal_id) is the "Goals produce plans/
--     playbooks" relation (spec/architecture-lock.md): immutable once set,
--     Client-scope-bound (a goal link requires client scope) and confined
--     to the owning Client (trigger rejects a goal of ANOTHER Client — the
--     Client boundary cannot be crossed through the goal column);
--   * the Playbook CONTAINER carries no lifecycle status: the frozen
--     state-machines.md defines the machine for PLAYBOOK VERSIONS only
--     (DRAFT → REVIEW → PUBLISHED → RETIRED). Retirement happens per
--     version; the container stays addressable reusable IP;
--   * each Playbook Version carries the EXPLICIT version identity that
--     downstream Deployment/Workflow references pin (marketing-cloud-
--     deployment-v1.4.md: a Deployment "references immutable Playbook/
--     Workflow versions" via playbook_version_id): version_id (the opaque
--     reference) plus a per-playbook monotonically increasing
--     version_number, together UNIQUE-fenced — a version number can never
--     be duplicated or reassigned within a playbook;
--   * strategy is the versioned strategy/plan artifact (implementation-
--     clarifications-v1.2: "Strategy/plan content is a versioned Goal-
--     owned or Playbook-owned artifact used to produce Workflow
--     Definitions") — an object, NOT a workflow graph (graph definitions
--     are the /workflows authority, MKT-008);
--   * deployment_metadata is the declarative deployment metadata (MKT-007
--     objective "reusable versioned Playbooks and deployment metadata"):
--     required Domain Pack versions, required Integration/Extension
--     capabilities, runtime requirements and trigger configuration that a
--     future Deployment will validate — persisted as structured data,
--     resolved by the /deployments authority, never here;
--   * PUBLISHED versions are IMMUTABLE (PLAY-AC-01): the database itself
--     rejects any content change to a published or retired version — the
--     single legal transition out of `published` is `published → retired`,
--     and even that must not touch content. RETIRED is fully frozen
--     terminal history (a pure no-op row write stays legal);
--   * provenance (created_by/created_at) is immutable history; ownership
--     is server-derived (the caller can never inject it);
--   * version CAS on both tables for concurrent mutation (row-locked
--     transitions).
--
-- Conventions (implementation-contract §3, §25): server-generated opaque
-- identifiers, created_at/updated_at, version CAS for concurrent mutation.
-- No owner/role/user columns: Playbook authorization stays exactly the
-- /agencies membership authority composed with canonical owner resolution
-- (/clients for Client-scoped playbooks) — no second tenant/permission/
-- workflow/execution/deployment authority.

CREATE TABLE IF NOT EXISTS playbooks (
    playbook_id       uuid        PRIMARY KEY,
    agency_id         uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    client_id         uuid        REFERENCES clients(client_id),
    goal_id           uuid        REFERENCES goals(goal_id),
    name              text        NOT NULL,
    description       text        NOT NULL DEFAULT '',
    created_by        uuid        REFERENCES users(user_id),
    version           bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playbook_versions (
    version_id          uuid        PRIMARY KEY,
    playbook_id         uuid        NOT NULL REFERENCES playbooks(playbook_id) ON DELETE CASCADE,
    version_number      integer     NOT NULL CHECK (version_number >= 1),
    status              text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'retired')),
    strategy            jsonb       NOT NULL CHECK (jsonb_typeof(strategy) = 'object'),
    deployment_metadata jsonb       NOT NULL CHECK (jsonb_typeof(deployment_metadata) = 'object'),
    created_by          uuid        REFERENCES users(user_id),
    version             bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- The EXPLICIT version reference fence: within one playbook a version
    -- number is assigned exactly once and can never be duplicated or
    -- reassigned (PLAY-AC-02 storage end of the explicit-version contract).
    CONSTRAINT playbook_versions_number_unique UNIQUE (playbook_id, version_number)
);

-- Listing surfaces: the Agency-scoped reusable IP of one Agency
-- (client_id IS NULL), and the playbooks scoped to one Client. No
-- uniqueness fence on names: playbooks are append-oriented versioned
-- artifacts, and concurrent creation is serialized by identity, not by
-- content.
CREATE INDEX IF NOT EXISTS playbooks_agency_idx
    ON playbooks (agency_id, created_at, playbook_id)
    WHERE client_id IS NULL;

CREATE INDEX IF NOT EXISTS playbooks_client_idx
    ON playbooks (client_id, created_at, playbook_id)
    WHERE client_id IS NOT NULL;

-- Immutability backstop (implementation-contract §3): Playbook identity,
-- Agency ownership, Client scope, Goal link and provenance can NEVER be
-- reassigned through ANY ordinary mutation path — the database itself
-- rejects the update. A Playbook can never cross the Agency boundary, its
-- Client scope can never migrate (including NULL ⇄ set), and its Goal link
-- can never be re-pointed.
CREATE OR REPLACE FUNCTION playbooks_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.playbook_id <> OLD.playbook_id THEN
        RAISE EXCEPTION 'playbook_id % is immutable', OLD.playbook_id;
    END IF;
    IF NEW.agency_id <> OLD.agency_id THEN
        RAISE EXCEPTION 'playbook % cannot change Agency ownership (was agency %)',
            OLD.playbook_id, OLD.agency_id;
    END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        RAISE EXCEPTION 'playbook % Client scope is immutable once set (was %)',
            OLD.playbook_id, COALESCE(OLD.client_id::text, 'agency-scoped');
    END IF;
    IF NEW.goal_id IS DISTINCT FROM OLD.goal_id THEN
        RAISE EXCEPTION 'playbook % Goal link is immutable once set (was %)',
            OLD.playbook_id, COALESCE(OLD.goal_id::text, 'unlinked');
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'playbook % provenance is immutable', OLD.playbook_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS playbooks_identity_immutable_trigger ON playbooks;
CREATE TRIGGER playbooks_identity_immutable_trigger
    BEFORE UPDATE ON playbooks
    FOR EACH ROW EXECUTE FUNCTION playbooks_identity_immutable();

-- Scope backstop: a Client-scoped Playbook must reference a Client of the
-- SAME Agency — the database itself rejects a cross-Agency client on
-- INSERT and on UPDATE, so the Agency boundary cannot be crossed through
-- the client column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION playbooks_client_within_agency() RETURNS trigger AS $$
BEGIN
    IF NEW.client_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM clients c
            WHERE c.client_id = NEW.client_id AND c.agency_id = NEW.agency_id
        ) THEN
            RAISE EXCEPTION 'playbook % client % does not belong to agency %',
                NEW.playbook_id, NEW.client_id, NEW.agency_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS playbooks_client_within_agency_trigger ON playbooks;
CREATE TRIGGER playbooks_client_within_agency_trigger
    BEFORE INSERT OR UPDATE ON playbooks
    FOR EACH ROW EXECUTE FUNCTION playbooks_client_within_agency();

-- Goal-link backstop ("Goals produce plans/playbooks"): a linked Goal must
-- belong to the playbook's OWN Client — the database itself rejects a goal
-- of another Client (or a goal link without Client scope) on INSERT and on
-- UPDATE, so the Client boundary cannot be crossed through the goal
-- column even if every application check were bypassed.
CREATE OR REPLACE FUNCTION playbooks_goal_within_client() RETURNS trigger AS $$
BEGIN
    IF NEW.goal_id IS NOT NULL THEN
        IF NEW.client_id IS NULL THEN
            RAISE EXCEPTION 'playbook % goal % requires Client scope (agency-scoped playbooks cannot link goals)',
                NEW.playbook_id, NEW.goal_id;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM goals g
            WHERE g.goal_id = NEW.goal_id AND g.client_id = NEW.client_id
        ) THEN
            RAISE EXCEPTION 'playbook % goal % does not belong to client %',
                NEW.playbook_id, NEW.goal_id, NEW.client_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS playbooks_goal_within_client_trigger ON playbooks;
CREATE TRIGGER playbooks_goal_within_client_trigger
    BEFORE INSERT OR UPDATE ON playbooks
    FOR EACH ROW EXECUTE FUNCTION playbooks_goal_within_client();

-- Version identity backstop: the explicit version reference (version_id,
-- playbook_id, version_number) and provenance can NEVER be reassigned — a
-- published or retired reference keeps pointing at exactly the content it
-- was created with, forever.
CREATE OR REPLACE FUNCTION playbook_versions_identity_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW.version_id <> OLD.version_id THEN
        RAISE EXCEPTION 'version_id % is immutable', OLD.version_id;
    END IF;
    IF NEW.playbook_id <> OLD.playbook_id THEN
        RAISE EXCEPTION 'playbook version % cannot change playbook ownership (was playbook %)',
            OLD.version_id, OLD.playbook_id;
    END IF;
    IF NEW.version_number <> OLD.version_number THEN
        RAISE EXCEPTION 'playbook version % number % is immutable',
            OLD.version_id, OLD.version_number;
    END IF;
    IF NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'playbook version % provenance is immutable', OLD.version_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS playbook_versions_identity_immutable_trigger ON playbook_versions;
CREATE TRIGGER playbook_versions_identity_immutable_trigger
    BEFORE UPDATE ON playbook_versions
    FOR EACH ROW EXECUTE FUNCTION playbook_versions_identity_immutable();

-- PLAY-AC-01 database backstop: PUBLISHED Playbook Versions are immutable.
-- Any content change to a published version (strategy, deployment
-- metadata, identity, provenance) is rejected by the database itself; the
-- single legal transition out of `published` is the content-preserving
-- `published → retired` retirement, and RETIRED rows are fully frozen
-- terminal history (a pure no-op row write stays legal and changes
-- nothing). Deployment "references the exact Playbook Version and does
-- not mutate it" (architecture.md §8) — this trigger is what makes that
-- reference safe at the storage layer.
CREATE OR REPLACE FUNCTION playbook_versions_published_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'retired' THEN
        IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
            RAISE EXCEPTION 'playbook version % is retired and frozen: version history is append-only',
                OLD.version_id;
        END IF;
    ELSIF OLD.status = 'published' THEN
        IF NEW.status NOT IN ('published', 'retired') THEN
            RAISE EXCEPTION 'published playbook version % can only transition to retired (attempted %)',
                OLD.version_id, NEW.status;
        END IF;
        IF NEW.strategy IS DISTINCT FROM OLD.strategy
           OR NEW.deployment_metadata IS DISTINCT FROM OLD.deployment_metadata THEN
            RAISE EXCEPTION 'published playbook version % content is immutable (PLAY-AC-01)',
                OLD.version_id;
        END IF;
        IF NEW.playbook_id <> OLD.playbook_id
           OR NEW.version_number <> OLD.version_number
           OR NEW.created_at <> OLD.created_at
           OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
            RAISE EXCEPTION 'published playbook version % identity and provenance are immutable',
                OLD.version_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS playbook_versions_published_immutable_trigger ON playbook_versions;
CREATE TRIGGER playbook_versions_published_immutable_trigger
    BEFORE UPDATE ON playbook_versions
    FOR EACH ROW EXECUTE FUNCTION playbook_versions_published_immutable();
