-- MKT-009 erratum correction — applied-transition history integrity backstop
-- (spec/errata/MKT-009-history-ledger.md; the Architect's defect ledger item:
-- "workflow_instance_transitions from_status consistency backstop needs its
-- own corrective migration / Work Item").
-- PostgreSQL is the system of record (spec/architecture-lock.md).
--
-- Migration 010 is applied and checksummed-immutable on main, so the
-- correction is delivered here as its own corrective migration that
-- CREATE OR REPLACEs the `workflow_instance_transitions_legal()` trigger
-- function with the consistency-augmented body — exactly the pattern of the
-- MKT-010 audit erratum correction for `execution_transitions_legal()`
-- (spec/errata/MKT-010-history-ledger.md), which MKT-012 then applied to
-- `sandbox_transitions` from day one.
--
-- THE DEFECT: the migration-010 history trigger verified only that
-- (from_status, to_status) is a legal frozen-§5 edge. It did NOT verify that
-- from_status equals the workflow instance row's durable current status, so a
-- direct SQL writer could insert a legal-looking but FABRICATED history row
-- that never represented the instance's actual state — e.g. for an instance
-- durably `succeeded`, a fabricated `draft → ready` row (a legal edge) was
-- accepted, polluting the authoritative record of applied state decisions.
--
-- THE CORRECTION: the history trigger resolves the target instance's CURRENT
-- durable status (SELECT ... FOR UPDATE — concurrency-safe; the authorized
-- writer already holds this row lock through lockWorkflowInstance before
-- inserting history, so the trigger re-enters under the same lock and a
-- racing writer serializes against the same serialization point the
-- transition path uses) and rejects:
--   * any history row for an UNKNOWN instance, and
--   * any history row whose from_status does not equal the instance's
--     durable current status — history must record the transition that was
--     actually applied, never a fabricated one.
--
-- The trigger name and wiring (workflow_instance_transitions_legal_trigger,
-- BEFORE INSERT ON workflow_instance_transitions, migration 010) are
-- unchanged — only the function body gains the backstop. No change to the
-- frozen §5 state machine, the workflow-instance authority (WF-AC-04: only
-- /workflows may mutate workflow-instance state), or module dependency
-- direction is intended.
CREATE OR REPLACE FUNCTION workflow_instance_transitions_legal() RETURNS trigger AS $$
DECLARE
    v_current_status text;
BEGIN
    IF NOT workflow_instance_transition_legal(NEW.from_status, NEW.to_status) THEN
        RAISE EXCEPTION 'illegal workflow instance transition % → % cannot be recorded',
            NEW.from_status, NEW.to_status;
    END IF;
    -- The from_status of a recorded transition must equal the instance's
    -- durable current status: history records what WAS applied, never a
    -- fabricated transition (the MKT-009 history-ledger erratum). FOR UPDATE
    -- = concurrency-safe (the authorized writer already holds this row lock;
    -- a racing writer serializes against the same serialization point the
    -- transition path uses).
    SELECT status INTO v_current_status
      FROM workflow_instances
     WHERE workflow_instance_id = NEW.workflow_instance_id
       FOR UPDATE;
    IF v_current_status IS NULL THEN
        RAISE EXCEPTION 'cannot record a transition for unknown workflow instance %',
            NEW.workflow_instance_id;
    END IF;
    IF v_current_status <> NEW.from_status THEN
        RAISE EXCEPTION 'fabricated applied transition rejected: workflow instance % is durably % but the history row claims from_status % — history must record the transition that was actually applied',
            NEW.workflow_instance_id, v_current_status, NEW.from_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
