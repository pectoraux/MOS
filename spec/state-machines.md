# MarketingOS State Machines

**Architecture Version:** 1.1
**Status:** FROZEN

## Workflow Instance

```text
DRAFT → READY → RUNNING
                 ├→ PAUSED → RUNNING
                 ├→ BLOCKED → RUNNING
                 ├→ SUCCEEDED
                 ├→ FAILED
                 └→ CANCELLED
```

Only `/workflows` may transition workflow-instance state. Terminal states are immutable.

## Task

```text
PENDING → ELIGIBLE → DISPATCHED → RUNNING
             ↑          ↓            ├→ SUCCEEDED
           BLOCKED    RETRY_WAIT      ├→ FAILED
                         ↓             ├→ CANCELLED
                      ELIGIBLE         └→ BLOCKED
```

Retry keeps the same logical Task identity.

## Execution

```text
CREATED → QUEUED → STARTING → RUNNING
                              ├→ PAUSING → PAUSED → RUNNING
                              ├→ SUCCEEDED
                              ├→ FAILED
                              ├→ CANCELLED
                              └→ UNKNOWN
```

`UNKNOWN` is terminal for the attempt outcome until an explicit reconciliation operation produces an authoritative external result; it is never interpreted as success.

## Job

```text
DRAFT → OPEN → OFFERED → ACCEPTED → IN_PROGRESS
                                      ├→ COMPLETED
                                      ├→ FAILED
                                      └→ CANCELLED
```

Acceptance is idempotent and must use a concurrency-safe claim.

## Sandbox

```text
REQUESTED → PREPARING → READY
                 ├→ FAILED
                 └→ CANCELLED
READY → RELEASING → RELEASED
READY → CANCELLED → RELEASED
```

Persistent sandboxes may remain provisioned only while authorized by policy. Release is idempotent and recoverable through the worker/outbox infrastructure.

## Playbook Version

```text
DRAFT → REVIEW → PUBLISHED → RETIRED
```

Published versions are immutable.

## Experiment

```text
DRAFT → READY → RUNNING → ANALYZING → CONCLUDED
                   ├→ STOPPED
                   └→ INVALIDATED
```

Conclusion state must preserve the declared design and analysis metadata.

## Extension Version

```text
DRAFT → VALIDATED → PUBLISHED → INSTALLED → DISABLED → RETIRED
```

Published version content is immutable.
