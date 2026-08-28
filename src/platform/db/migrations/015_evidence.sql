-- MKT-013 Evidence and provenance schema (EVID-001).
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Table ownership follows the frozen authority map (implementation-contract
-- §1): /evidence is the single Evidence/provenance authority. There is no
-- competing metrics/experiments/learnings authority here — those modules own
-- their own records later and may only relate to evidence through this
-- surface (module-dependency-matrix.md: /metrics ──→ /evidence,
-- /experiments ──→ /evidence, /learnings ──→ /evidence, /evidence ──→
-- /clients, /workspaces, /executions).
--
-- Frozen semantics encoded here (spec/work-items.md MKT-013 "implement
-- source facts, observations, provenance, evidence quality, append-oriented
-- history and references"; requirements.md EVID-001 + EVID-AC-01..03;
-- spec/implementation-contract.md §13 "Evidence contract", §14 "Claims",
-- §3 "Required identifiers", §25 "Persistence contract";
-- spec/evidence-and-experimentation.md "Evidence classes"/"Provenance"/
-- "Evidence quality"; spec/architecture.md §15 "Evidence graph" — "Evidence
-- is append-oriented and server-owned"; spec/security-threat-model.md
-- "Evidence fabrication": "provenance is server-owned; source observations
-- are collected through evidence authorities; extension/agent outputs are
-- claims until supported"):
--
--   * the durable Evidence record carries the full §13 shape: evidence_id,
--     client/workspace scope (server-derived through canonical Workspace
--     ownership resolution), source identity + source locator/reference,
--     retrieved_at (server clock) and source_observed_at when known,
--     provenance, evidence_class, quality_grade, content + optional
--     immutable artifact reference, server-computed content digest, the
--     actor/system that collected it, applicability scope, and the
--     supersedes/contradicts/supports references (EVID-AC-01);
--   * the FROZEN evidence-class taxonomy (evidence-and-experimentation.md):
--     source_fact, observation, inference, hypothesis, attribution,
--     prediction, causal_estimate, learning — and the ordered-but-
--     non-absolute quality taxonomy A..F (extensible later, always
--     interpretable and traceable);
--   * the CLASS↔PROVENANCE CREATION PAIRING (the structural half of
--     EVID-AC-03, security-threat-model "Evidence fabrication"): source
--     collections (source_fact, observation) enter the ledger with
--     provenance OBSERVED — they are collected through this evidence
--     authority — while every CLAIM class (inference, hypothesis,
--     attribution, prediction, causal_estimate, learning) enters with
--     provenance PROPOSED. A model/human/extension output can NEVER be
--     born as an authoritative observation: a BEFORE INSERT trigger
--     rejects the pairing at the database level, direct SQL included
--     (the pairing is a CREATION rule enforced at INSERT — provenance
--     then legitimately moves through the explicit promotion port);
--   * PROVENANCE PROMOTION is an explicit authorized operation
--     (implementation-contract §13: "Promotion is an explicit authorized
--     operation; confidence scores never promote provenance"): the frozen
--     promotion graph is proposed → inferred → confirmed, with observed and
--     confirmed terminal. There is NO edge into observed — a claim was
--     never collected from a source, so nothing can make it observed.
--     Promotion to inferred additionally requires at least one supports
--     relationship to OBSERVED evidence ("extension/agent outputs are
--     claims until supported" — an interpretation is supported by source
--     observations). Confidence scores are not a field anywhere in this
--     schema: no score can promote anything;
--   * APPEND-ORIENTED HISTORY (EVID-AC-02): the record's content is
--     immutable — a BEFORE UPDATE trigger freezes every column except
--     provenance/version/updated_at (the promotion port) — and rows are
--     NEVER deleted (an unconditional BEFORE DELETE trigger rejects the
--     statement; the MKT-012 ledger-preserving delete policy applied from
--     day one). Supersession is a NEW record that references the old one;
--     the superseded record is never rewritten. The promotion ledger
--     (evidence_transitions) and the reference graph
--     (evidence_relationships) are append-only with NON-DESTRUCTIVE
--     foreign keys (no ON DELETE CASCADE anywhere);
--   * the provenance ledger carries the from_provenance CONSISTENCY
--     backstop (the guarantee the MKT-009/MKT-010/MKT-012 corrections
--     established for the other lifecycle ledgers, applied here from day
--     one): a history row is the record of a decision that WAS APPLIED —
--     the trigger resolves the evidence row FOR UPDATE and rejects
--     fabricated history whose from_provenance does not match the durable
--     provenance, and any history row for unknown evidence;
--   * the CLAIM SUPPORT contract (implementation-contract §14 "A
--     Claim/Inference must reference one or more supporting Evidence
--     records"): a DEFERRABLE constraint trigger enforces at COMMIT that
--     every claim-class record carries at least one supports relationship
--     (the module creates record + relationships in one transaction, so
--     the authorized path always satisfies it; direct-SQL claim inserts
--     without supports fail at commit). A causal_estimate additionally
--     REQUIRES its declared quasi-experimental analysis reference (§14 "A
--     causal claim requires an Experiment or declared quasi-experimental
--     analysis reference") and no other class may carry one — attribution
--     evidence cannot be serialized as a causal conclusion;
--   * references stay IN SCOPE: a relationship may only connect two
--     evidence records of the SAME agency/client/workspace (the
--     cross-scope fence rejects cross-tenant and cross-workspace
--     references at the database level), and the scope chain of the record
--     itself is verified against the durable workspace→client ownership
--     (agency_id/client_id/workspace_id consistency — a caller-supplied
--     UUID is never authorization, and fabricated cross-scoped rows are
--     rejected);
--   * required identifiers (implementation-contract §3): immutable opaque
--     evidence_id, created_at, updated_at (mutable only through the
--     promotion port), version CAS for the concurrent promotion path, and
--     audit correlation is attached by the API pipeline's audit emission.
--
-- The table has no `executed_by`/`execution_id` column: the frozen §13
-- record shape carries no execution ownership, and /evidence must not
-- mutate workflow/execution state (module-dependency-matrix.md rule). The
-- /evidence ──→ /executions dependency is therefore UNUSED by this Work
-- Item (execution→evidence references arrive with the engine/AI
-- composition Work Items).

CREATE TABLE IF NOT EXISTS evidence_records (
    evidence_id          uuid        PRIMARY KEY,
    agency_id            uuid        NOT NULL REFERENCES agencies(agency_id),
    client_id            uuid        NOT NULL REFERENCES clients(client_id),
    workspace_id         uuid        NOT NULL REFERENCES workspaces(workspace_id),
    evidence_class       text        NOT NULL
                         CHECK (evidence_class IN ('source_fact', 'observation',
                                                   'inference', 'hypothesis',
                                                   'attribution', 'prediction',
                                                   'causal_estimate', 'learning')),
    provenance           text        NOT NULL
                         CHECK (provenance IN ('observed', 'inferred', 'confirmed', 'proposed')),
    quality_grade        text        NOT NULL
                         CHECK (quality_grade IN ('A', 'B', 'C', 'D', 'E', 'F')),
    source_identity      text        NOT NULL
                         CHECK (length(source_identity) >= 1 AND length(source_identity) <= 200),
    source_locator       text        NOT NULL
                         CHECK (length(source_locator) >= 1 AND length(source_locator) <= 1000),
    retrieved_at         timestamptz NOT NULL,
    source_observed_at   timestamptz,
    collected_by         text        NOT NULL
                         CHECK (length(collected_by) >= 1 AND length(collected_by) <= 200),
    content              text        NOT NULL
                         CHECK (length(content) >= 1 AND length(content) <= 100000),
    artifact_ref         text
                         CHECK (artifact_ref IS NULL OR (length(artifact_ref) >= 1
                                                         AND length(artifact_ref) <= 500)),
    content_digest       text        NOT NULL CHECK (length(content_digest) = 64),
    applicability        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- §14: a causal claim requires a declared quasi-experimental analysis
    -- reference (the Experiment reference disjunct arrives with MKT-015)
    -- and only causal_estimate may carry one — attribution evidence cannot
    -- be serialized as a causal conclusion.
    declared_analysis_ref text       CHECK (declared_analysis_ref IS NULL
                                            OR (length(declared_analysis_ref) >= 1
                                                AND length(declared_analysis_ref) <= 1000)),
    version              bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    -- §14 causal guard: declared_analysis_ref exists exactly for
    -- causal_estimate. This is a stable row invariant (class and the
    -- declared analysis reference are both immutable after creation — the
    -- frozen-content trigger pins them), so a CHECK is correct here.
    CONSTRAINT evidence_causal_analysis_shape CHECK (
        (evidence_class = 'causal_estimate' AND declared_analysis_ref IS NOT NULL)
        OR (evidence_class <> 'causal_estimate' AND declared_analysis_ref IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS evidence_records_workspace_idx
    ON evidence_records (workspace_id, created_at, evidence_id);
CREATE INDEX IF NOT EXISTS evidence_records_digest_idx
    ON evidence_records (content_digest);
CREATE INDEX IF NOT EXISTS evidence_records_provenance_idx
    ON evidence_records (workspace_id, provenance);

-- ---------------------------------------------------------------------------
-- The CLASS↔PROVENANCE CREATION PAIRING (EVID-AC-03's structural half,
-- security-threat-model.md "Evidence fabrication"). This is a CREATION
-- rule, not a row invariant: provenance legitimately moves to
-- inferred/confirmed through the explicit promotion port below, so the
-- pairing is enforced by a BEFORE INSERT trigger — a source collection
-- (source_fact/observation) can only ever be BORN observed (collected
-- through this evidence authority), and a claim class can only ever be
-- BORN proposed (a model/human/extension output was never collected from
-- a source). Direct SQL cannot fabricate either pairing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION evidence_creation_pairing() RETURNS trigger AS $$
BEGIN
    IF NEW.evidence_class IN ('source_fact', 'observation') THEN
        IF NEW.provenance <> 'observed' THEN
            RAISE EXCEPTION 'source collections (evidence class %) are born OBSERVED through the evidence authority — fabricated provenance % rejected (EVID-AC-03)',
                NEW.evidence_class, NEW.provenance;
        END IF;
    ELSE
        IF NEW.provenance <> 'proposed' THEN
            RAISE EXCEPTION 'claims (evidence class %) are born PROPOSED — a claim was never collected from a source; fabricated provenance % rejected (EVID-AC-03)',
                NEW.evidence_class, NEW.provenance;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_creation_pairing_trigger ON evidence_records;
CREATE TRIGGER evidence_creation_pairing_trigger
    BEFORE INSERT ON evidence_records
    FOR EACH ROW EXECUTE FUNCTION evidence_creation_pairing();

-- ---------------------------------------------------------------------------
-- The reference graph: supports / supersedes / contradicts (§13
-- "supersedes/contradicts references" + §14 "must reference one or more
-- supporting Evidence records").
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_relationships (
    relationship_id     uuid        PRIMARY KEY,
    evidence_id         uuid        NOT NULL REFERENCES evidence_records(evidence_id),
    related_evidence_id uuid        NOT NULL REFERENCES evidence_records(evidence_id),
    relationship_type   text        NOT NULL
                        CHECK (relationship_type IN ('supports', 'supersedes', 'contradicts')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT evidence_relationships_unique
        UNIQUE (evidence_id, related_evidence_id, relationship_type),
    CONSTRAINT evidence_relationships_no_self
        CHECK (evidence_id <> related_evidence_id)
);

CREATE INDEX IF NOT EXISTS evidence_relationships_subject_idx
    ON evidence_relationships (evidence_id, relationship_type, related_evidence_id);
CREATE INDEX IF NOT EXISTS evidence_relationships_target_idx
    ON evidence_relationships (related_evidence_id, relationship_type, evidence_id);

-- References stay in scope: both endpoints of every relationship must be
-- evidence records of the SAME agency/client/workspace. Cross-tenant and
-- cross-workspace references are rejected at the database level — a
-- foreign evidence identifier is not a traversal path.
CREATE OR REPLACE FUNCTION evidence_relationships_scope_consistent() RETURNS trigger AS $$
DECLARE
    v_subject_agency uuid;
    v_subject_client  uuid;
    v_subject_workspace uuid;
    v_target_agency   uuid;
    v_target_client   uuid;
    v_target_workspace uuid;
BEGIN
    SELECT agency_id, client_id, workspace_id
      INTO v_subject_agency, v_subject_client, v_subject_workspace
      FROM evidence_records WHERE evidence_id = NEW.evidence_id;
    SELECT agency_id, client_id, workspace_id
      INTO v_target_agency, v_target_client, v_target_workspace
      FROM evidence_records WHERE evidence_id = NEW.related_evidence_id;
    IF v_subject_workspace IS NULL THEN
        RAISE EXCEPTION 'unknown evidence % referenced by relationship %',
            NEW.evidence_id, NEW.relationship_id;
    END IF;
    IF v_target_workspace IS NULL THEN
        RAISE EXCEPTION 'unknown evidence % referenced by relationship %',
            NEW.related_evidence_id, NEW.relationship_id;
    END IF;
    IF v_subject_agency <> v_target_agency
       OR v_subject_client <> v_target_client
       OR v_subject_workspace <> v_target_workspace THEN
        RAISE EXCEPTION 'cross-scope evidence reference rejected: evidence % and evidence % do not share one workspace scope',
            NEW.evidence_id, NEW.related_evidence_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_relationships_scope_consistent_trigger ON evidence_relationships;
CREATE TRIGGER evidence_relationships_scope_consistent_trigger
    BEFORE INSERT ON evidence_relationships
    FOR EACH ROW EXECUTE FUNCTION evidence_relationships_scope_consistent();

-- The reference graph is append-oriented: relationships are never rewritten
-- or erased. A changed relationship is a NEW relationship row.
CREATE OR REPLACE FUNCTION evidence_relationships_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'evidence relationships are append-only: % is rejected on relationship %',
        TG_OP, OLD.relationship_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_relationships_append_only_trigger ON evidence_relationships;
CREATE TRIGGER evidence_relationships_append_only_trigger
    BEFORE UPDATE OR DELETE ON evidence_relationships
    FOR EACH ROW EXECUTE FUNCTION evidence_relationships_append_only();

-- ---------------------------------------------------------------------------
-- The provenance promotion ledger (§13 "Promotion is an explicit authorized
-- operation") — the same ledger discipline as the workflow-instance,
-- execution and sandbox transition ledgers, with the from_provenance
-- consistency backstop applied FROM DAY ONE (the MKT-009/MKT-010/MKT-012
-- corrections' guarantee).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_transitions (
    evidence_transition_id uuid       PRIMARY KEY,
    evidence_id            uuid       NOT NULL REFERENCES evidence_records(evidence_id),
    idempotency_key        text       NOT NULL
                           CHECK (length(idempotency_key) >= 1 AND length(idempotency_key) <= 200),
    from_provenance        text       NOT NULL
                           CHECK (from_provenance IN ('observed', 'inferred', 'confirmed', 'proposed')),
    to_provenance          text       NOT NULL
                           CHECK (to_provenance IN ('observed', 'inferred', 'confirmed', 'proposed')),
    reason                 text       NOT NULL
                           CHECK (length(reason) >= 1 AND length(reason) <= 2000),
    created_by             uuid       REFERENCES users(user_id),
    created_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT evidence_transitions_key_unique UNIQUE (evidence_id, idempotency_key),
    CONSTRAINT evidence_transitions_shape CHECK (from_provenance <> to_provenance)
);

CREATE INDEX IF NOT EXISTS evidence_transitions_evidence_idx
    ON evidence_transitions (evidence_id, created_at, evidence_transition_id);

-- The frozen promotion graph (the documented MKT-013 policy decision inside
-- the frozen §13 contract language): proposed → inferred → confirmed;
-- observed and confirmed are terminal; there is NO edge into observed — a
-- claim was never collected from a source.
CREATE OR REPLACE FUNCTION evidence_provenance_promotion_legal(from_provenance text, to_provenance text)
RETURNS boolean AS $$
    SELECT CASE
        WHEN from_provenance = 'proposed' THEN to_provenance = 'inferred'
        WHEN from_provenance = 'inferred' THEN to_provenance = 'confirmed'
        ELSE false
    END;
$$ LANGUAGE sql IMMUTABLE;

-- History legality: the legal promotion edge only (the reason is NOT NULL
-- at the column level — promotion is never silent).
CREATE OR REPLACE FUNCTION evidence_transitions_legal() RETURNS trigger AS $$
BEGIN
    IF NOT evidence_provenance_promotion_legal(NEW.from_provenance, NEW.to_provenance) THEN
        RAISE EXCEPTION 'illegal provenance promotion % → % (provenance promotion is explicit: proposed → inferred → confirmed; observed is terminal)',
            NEW.from_provenance, NEW.to_provenance;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_transitions_legal_trigger ON evidence_transitions;
CREATE TRIGGER evidence_transitions_legal_trigger
    BEFORE INSERT ON evidence_transitions
    FOR EACH ROW EXECUTE FUNCTION evidence_transitions_legal();

-- History/row consistency (the MKT-009/MKT-010/MKT-012 backstop, applied
-- from day one): a recorded promotion is the record of a decision that WAS
-- APPLIED — the trigger resolves the evidence row concurrency-safely (FOR
-- UPDATE — re-entrant under the authorized path's row lock) and rejects
-- history rows whose from_provenance does not equal the record's durable
-- provenance, and any history row for unknown evidence.
CREATE OR REPLACE FUNCTION evidence_transitions_consistent() RETURNS trigger AS $$
DECLARE
    v_current_provenance text;
BEGIN
    SELECT provenance INTO v_current_provenance FROM evidence_records
     WHERE evidence_id = NEW.evidence_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot record a provenance transition for unknown evidence %', NEW.evidence_id;
    END IF;
    IF v_current_provenance <> NEW.from_provenance THEN
        RAISE EXCEPTION 'fabricated applied promotion rejected: evidence % is durably % but the history row claims from_provenance %',
            NEW.evidence_id, v_current_provenance, NEW.from_provenance;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_transitions_consistent_trigger ON evidence_transitions;
CREATE TRIGGER evidence_transitions_consistent_trigger
    BEFORE INSERT ON evidence_transitions
    FOR EACH ROW EXECUTE FUNCTION evidence_transitions_consistent();

-- The promotion ledger is append-only: applied history is never rewritten.
CREATE OR REPLACE FUNCTION evidence_transitions_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'evidence provenance history % is append-only', OLD.evidence_transition_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_transitions_append_only_trigger ON evidence_transitions;
CREATE TRIGGER evidence_transitions_append_only_trigger
    BEFORE UPDATE OR DELETE ON evidence_transitions
    FOR EACH ROW EXECUTE FUNCTION evidence_transitions_append_only();

-- ---------------------------------------------------------------------------
-- The evidence row backstops.
-- ---------------------------------------------------------------------------

-- The record's content is FROZEN: only provenance (through the promotion
-- port below), version and updated_at may ever change. Every other column
-- — scope, class, quality, source identity/locator, timestamps, collector,
-- content, artifact reference, digest, applicability, declared analysis —
-- is immutable history (EVID-AC-02: append-oriented, never overwritten).
CREATE OR REPLACE FUNCTION evidence_records_frozen() RETURNS trigger AS $$
BEGIN
    IF NEW.evidence_id <> OLD.evidence_id
       OR NEW.agency_id <> OLD.agency_id
       OR NEW.client_id <> OLD.client_id
       OR NEW.workspace_id <> OLD.workspace_id
       OR NEW.evidence_class <> OLD.evidence_class
       OR NEW.quality_grade <> OLD.quality_grade
       OR NEW.source_identity <> OLD.source_identity
       OR NEW.source_locator <> OLD.source_locator
       OR NEW.retrieved_at <> OLD.retrieved_at
       OR NEW.source_observed_at <> OLD.source_observed_at
       OR NEW.collected_by <> OLD.collected_by
       OR NEW.content <> OLD.content
       OR NEW.artifact_ref <> OLD.artifact_ref
       OR NEW.content_digest <> OLD.content_digest
       OR NEW.applicability <> OLD.applicability
       OR NEW.declared_analysis_ref <> OLD.declared_analysis_ref
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'evidence % is append-oriented: record content is immutable (only provenance may be promoted)',
            OLD.evidence_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_records_frozen_trigger ON evidence_records;
CREATE TRIGGER evidence_records_frozen_trigger
    BEFORE UPDATE ON evidence_records
    FOR EACH ROW EXECUTE FUNCTION evidence_records_frozen();

-- The provenance machine: legal promotion edges only, and promotion to
-- inferred requires at least one supports relationship to OBSERVED evidence
-- (security-threat-model.md: "extension/agent outputs are claims until
-- supported"; evidence-and-experimentation.md: an inference is an
-- "interpretation supported by observed evidence"). Confidence scores are
-- not an input — no such field exists.
CREATE OR REPLACE FUNCTION evidence_provenance_machine() RETURNS trigger AS $$
BEGIN
    IF NEW.provenance = OLD.provenance THEN
        RETURN NEW;
    END IF;
    IF NOT evidence_provenance_promotion_legal(OLD.provenance, NEW.provenance) THEN
        RAISE EXCEPTION 'illegal provenance promotion % → % for evidence % (provenance promotion is explicit: proposed → inferred → confirmed; observed is terminal)',
            OLD.provenance, NEW.provenance, OLD.evidence_id;
    END IF;
    IF NEW.provenance = 'inferred' THEN
        IF NOT EXISTS (
            SELECT 1 FROM evidence_relationships r
              JOIN evidence_records src ON src.evidence_id = r.related_evidence_id
             WHERE r.evidence_id = NEW.evidence_id
               AND r.relationship_type = 'supports'
               AND src.provenance = 'observed'
        ) THEN
            RAISE EXCEPTION 'promotion to inferred for evidence % requires supporting evidence that was OBSERVED (claims are claims until supported by source observations)',
                OLD.evidence_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_provenance_machine_trigger ON evidence_records;
CREATE TRIGGER evidence_provenance_machine_trigger
    BEFORE UPDATE OF provenance ON evidence_records
    FOR EACH ROW EXECUTE FUNCTION evidence_provenance_machine();

-- LEDGER-PRESERVING DELETE POLICY (the MKT-012 correction's rule, applied
-- from day one): evidence rows are NEVER deleted — evidence is append-
-- oriented history. Supersession references the old record; it never erases
-- it. The rejection is UNCONDITIONAL (no empty-ledger escape hatch).
CREATE OR REPLACE FUNCTION evidence_delete_rejected() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'evidence % rows are never deleted; evidence is append-oriented history (supersession references it, never erases it)',
        OLD.evidence_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_delete_rejected_trigger ON evidence_records;
CREATE TRIGGER evidence_delete_rejected_trigger
    BEFORE DELETE ON evidence_records
    FOR EACH ROW EXECUTE FUNCTION evidence_delete_rejected();

-- Scope-chain fence: the record's agency/client/workspace must match the
-- durable workspace→client ownership chain (server-derived by the module
-- through canonical Workspace ownership resolution; direct-SQL cross-scoped
-- fabrications are rejected here).
CREATE OR REPLACE FUNCTION evidence_scope_chain() RETURNS trigger AS $$
DECLARE
    v_client_id uuid;
    v_agency_id uuid;
BEGIN
    SELECT w.client_id, c.agency_id INTO v_client_id, v_agency_id
      FROM workspaces w
      JOIN clients c ON c.client_id = w.client_id
     WHERE w.workspace_id = NEW.workspace_id;
    IF v_client_id IS NULL THEN
        RAISE EXCEPTION 'evidence % scope chain broken: workspace % does not exist',
            NEW.evidence_id, NEW.workspace_id;
    END IF;
    IF v_client_id <> NEW.client_id OR v_agency_id <> NEW.agency_id THEN
        RAISE EXCEPTION 'cross-scope evidence rejected: workspace % belongs to client % (agency %), not client % (agency %)',
            NEW.workspace_id, v_client_id, v_agency_id, NEW.client_id, NEW.agency_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_scope_chain_trigger ON evidence_records;
CREATE TRIGGER evidence_scope_chain_trigger
    BEFORE INSERT OR UPDATE ON evidence_records
    FOR EACH ROW EXECUTE FUNCTION evidence_scope_chain();

-- The CLAIM SUPPORT contract (implementation-contract §14 sentence one): a
-- Claim/Inference must reference one or more supporting Evidence records.
-- Enforced at COMMIT via a DEFERRABLE constraint trigger: the authorized
-- creation path writes record + supports relationships in ONE transaction,
-- while a direct-SQL claim insert without any supports row fails at commit.
CREATE OR REPLACE FUNCTION evidence_claims_supported() RETURNS trigger AS $$
BEGIN
    IF NEW.evidence_class NOT IN ('source_fact', 'observation') THEN
        IF NOT EXISTS (
            SELECT 1 FROM evidence_relationships r
             WHERE r.evidence_id = NEW.evidence_id
               AND r.relationship_type = 'supports'
        ) THEN
            RAISE EXCEPTION 'a claim (evidence class %) must reference one or more supporting evidence records',
                NEW.evidence_class;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_claims_supported_trigger ON evidence_records;
CREATE CONSTRAINT TRIGGER evidence_claims_supported_trigger
    AFTER INSERT ON evidence_records
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION evidence_claims_supported();
