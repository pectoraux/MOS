# ADR-0002 — Agent Is a Logical Capability, Not a VM

**Status:** Accepted / Frozen

Agents are reusable logical capabilities. Execution acquires runtime resources. The default is pooled workers; sandboxes exist only when execution requirements justify them. This follows the persistent-environment insight from systems such as Grok Bot without imposing VM-per-client economics.
