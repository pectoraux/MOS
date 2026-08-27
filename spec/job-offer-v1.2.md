# Field Job Offer Contract — v1.2

## Purpose

A Job is the governed projection of one Workflow Task for human execution. Distribution to the field-agent pool must not create a second workflow or task identity.

## Offer model

A Job may have multiple candidate-specific Offers. An Offer is not a second Job and does not authorize Client data beyond the Job scope.

```text
Task
 ↓
Job
 ↓
Offer × eligible Field Agents
 ↓
one winning acceptance
 ↓
Job ACCEPTED
```

## Offer rules

- Candidate matching is evaluated from declared territory/geofence, capability, availability, policy, relationship continuity and reliability signals.
- An Offer contains only the minimum information required for the candidate to decide whether to accept.
- Acceptance is a compare-and-set against the Job's version/state. Exactly one acceptance may win unless the Job definition explicitly permits parallel staffing.
- Losing offers transition to `EXPIRED` or `WITHDRAWN` and cannot later claim the Job.
- Replayed acceptance of the already accepted Offer is idempotent; acceptance of a different Offer after the Job has been claimed returns a conflict without exposing unrelated Client data.
- A Field Agent can reject/decline an Offer without affecting the underlying Task.
- Job completion remains subject to required evidence and server-side validation; a Field Agent's narrative does not itself establish `OBSERVED` or `CONFIRMED` truth.
