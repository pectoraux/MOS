# MarketingOS Work Item Template

Every implementation Work Item handled by an LLM must be accompanied by a Work Order containing these fields.

## Identity

- Work Item ID
- Architecture Version
- Repository baseline/commit
- Implementing agent/execution ID

## Objective

One precise statement of what changes.

## Requirements

Exact requirement IDs and acceptance criteria IDs.

## Dependencies

Exact Work Item IDs and the repository evidence proving they are complete.

## Authority map

- authoritative modules consumed;
- authoritative modules mutated;
- provider boundaries used;
- forbidden authorities/paths.

## Data contract

Entities, fields, ownership, state transitions, uniqueness, append-only/immutability constraints and migrations required.

## API/event contract

Routes, request/response shapes, server-derived fields, error codes, asynchronous jobs, event inputs and idempotency keys.

## Security contract

Authorization checks, tenant guards, credential rules, network/runtime restrictions and negative tests.

## Concurrency/recovery contract

CAS predicates, uniqueness fences, transaction boundaries, leases, retries, crash windows, UNKNOWN handling and reconciliation.

## Verification contract

Exact commands/tests, required real integrations, required static-architecture checks and any environment limitations.

## Out of scope

Explicitly state which frozen areas must not be changed.

## Definition of done

All acceptance criteria proved by objective evidence; no architecture file modified; no unresolved authority-boundary violation.
