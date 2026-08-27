# Human Agent Contract — v1.3

**Status:** FROZEN
**Supersedes:** the v1.2 use of `Field Agent` as the only human execution role.

## 1. Human Agent

A Human Agent is a platform identity authorized to perform governed human Tasks through Jobs.

A Human Agent has:

- stable platform identity;
- capabilities/skills;
- availability;
- optional geography/territories;
- reliability/quality signals;
- relationship-continuity preferences;
- authorization/contract state.

Human Agent is not a tenant and does not own Client data merely by being eligible for a Job.

## 2. Field Agent specialization

`Field Agent` is a specialization of Human Agent with location/territory and in-person execution capabilities.

Other specializations may include:

- Chatter;
- Creator Manager;
- Content Manager;
- Account Manager;
- Reviewer;
- Sales Agent.

A specialization is capability metadata, not a second execution model.

## 3. Job access

A Job exposes only the minimum data required for the Human Agent to perform its governed Task. Job eligibility MUST be evaluated before exposing Client-specific details.

A Human Agent may participate in multiple Agencies and Clients, but every Job/Execution is scoped to exactly one commissioning Agency and Client.

## 4. Assignment

The platform Job authority owns assignment state. Candidate-specific Offers may be created for eligible Human Agents. Acceptance is a concurrency-safe claim using the v1.2 Job Offer contract.

## 5. Human evidence

Human-submitted observations are actor-attributed evidence submissions. The submitting Human Agent cannot self-authorize provenance promotion or causal conclusions.

## 6. No special human workflow

Human Agents use the same Task, Execution, Evidence, Audit, Policy, and Workflow authorities as AI, deterministic software, and extensions.
