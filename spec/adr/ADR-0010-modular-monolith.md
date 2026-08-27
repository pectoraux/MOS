# ADR-0010 — Modular Monolith First

**Status:** Accepted / Frozen

The initial backend is a modular monolith with asynchronous workers. Heavy runtime components can be separately deployed while domain contracts remain stable. Microservices are not required to establish the architecture.
