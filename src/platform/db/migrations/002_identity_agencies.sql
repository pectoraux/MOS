-- MKT-002 identity, agency membership and roles schema.
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract §1):
--   users, user_platform_roles        → /users   (user identity/profile)
--   auth_credentials, auth_sessions   → /auth    (authentication identity;
--                                                 credential/session material
--                                                 stays behind this boundary)
--   agencies, agency_memberships      → /agencies (Agency/membership)
--
-- Conventions (implementation-contract §3, §25):
--   * server-generated opaque identifiers (uuid) and timestamps everywhere;
--   * version columns implement CAS for every concurrently mutable row;
--   * critical uniqueness/invariants are fenced by the DATABASE itself
--     (duplicate membership, active credential, session token, slug, email);
--   * role assignment is orthogonal to tenant ownership: agency ownership is
--     a MEMBERSHIP ROLE (agency_owner), never an owner column on agencies,
--     and platform roles are user-scoped rows, never a users.is_admin flag.
--
-- NOTE: role CHECK constraints below must exactly mirror the canonical role
-- registries exported by the module public contracts:
--   src/modules/users/public.ts     PLATFORM_ROLE_KEYS
--   src/modules/agencies/public.ts  AGENCY_ROLE_KEYS
-- (tests/architecture/roles-model.test.ts fails if they ever drift).

-- ---------------------------------------------------------------------------
-- /users: user identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    user_id      uuid        PRIMARY KEY,
    email        text        NOT NULL,
    display_name text        NOT NULL,
    status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    version      bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Email is the human-facing identity anchor, normalized (lowercase, trimmed)
-- by the /users authority before persistence.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

-- Platform-scoped role assignment (Platform Administrator, Platform Developer/
-- Extension Publisher). Orthogonal to agency membership: a platform role row
-- never grants or implies agency ownership, and vice versa.
CREATE TABLE IF NOT EXISTS user_platform_roles (
    user_id    uuid        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role       text        NOT NULL CHECK (role IN ('platform_administrator', 'platform_developer')),
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

-- ---------------------------------------------------------------------------
-- /auth: credentials and sessions (secrets stay behind the auth boundary)
--
-- The verifier is a scrypt hash; the RAW password never reaches persistence.
-- Sessions store only the SHA-256 hash of the opaque bearer token; the raw
-- token exists only client-side after login.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_credentials (
    credential_id uuid        PRIMARY KEY,
    user_id       uuid        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    scheme        text        NOT NULL DEFAULT 'scrypt',
    verifier      text        NOT NULL,
    status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    version       bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one ACTIVE credential per user (replacement revokes the previous).
CREATE UNIQUE INDEX IF NOT EXISTS auth_credentials_active_fence
    ON auth_credentials (user_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS auth_credentials_user_idx ON auth_credentials (user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id   uuid        PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash   text        NOT NULL,
    status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at   timestamptz,
    version      bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Session tokens are unguessable random values addressed by their hash.
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_hash_key ON auth_sessions (token_hash);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
    ON auth_sessions (user_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- /agencies: Agency, membership and agency-scoped roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agencies (
    agency_id  uuid        PRIMARY KEY,
    name       text        NOT NULL,
    slug       text        NOT NULL,
    status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_by uuid        REFERENCES users(user_id),
    version    bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- No owner column: Agency ownership is a membership ROLE (agency_owner).
CREATE UNIQUE INDEX IF NOT EXISTS agencies_slug_key ON agencies (slug);

CREATE TABLE IF NOT EXISTS agency_memberships (
    membership_id uuid        PRIMARY KEY,
    agency_id     uuid        NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    user_id       uuid        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role          text        NOT NULL CHECK (role IN (
        'agency_owner', 'agency_admin', 'agency_operator',
        'client_collaborator', 'human_agent')),
    status        text        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled', 'revoked')),
    version       bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);

-- DB fence (issue #6 concurrency contract): duplicate membership creation is
-- rejected by the database. Revoked memberships are historical rows and do
-- not block re-adding the same user later.
CREATE UNIQUE INDEX IF NOT EXISTS agency_memberships_membership_fence
    ON agency_memberships (agency_id, user_id) WHERE status IN ('active', 'disabled');

CREATE INDEX IF NOT EXISTS agency_memberships_agency_idx
    ON agency_memberships (agency_id) WHERE status <> 'revoked';

CREATE INDEX IF NOT EXISTS agency_memberships_user_idx
    ON agency_memberships (user_id) WHERE status <> 'revoked';

-- Membership lifecycle backstop: revoked memberships are terminal rows;
-- they may never silently come back to life via UPDATE.
CREATE OR REPLACE FUNCTION agency_memberships_revoked_terminal() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
        RAISE EXCEPTION 'membership % is revoked and terminal', OLD.membership_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agency_memberships_revoked_terminal_trigger ON agency_memberships;
CREATE TRIGGER agency_memberships_revoked_terminal_trigger
    BEFORE UPDATE ON agency_memberships
    FOR EACH ROW EXECUTE FUNCTION agency_memberships_revoked_terminal();
