# MarketingOS Product Scope

**Status:** FROZEN with Architecture Version 1.0

## 1. Product thesis

MarketingOS gives agencies a shared operating system for running client acquisition. Agencies connect client systems once, define measurable goals, deploy reusable playbooks, execute work through AI/software/humans/extensions, measure outcomes, and preserve the resulting evidence and learnings.

## 2. Primary customer

Initial target:

> Performance/growth agencies serving approximately 10–100 active clients.

These agencies have repeated workflows, heterogeneous marketing systems, measurable conversion outcomes, and a strong economic incentive to increase operator leverage.

## 3. Initial wedge

The first product surface is three workflows:

1. **Weekly Client Intelligence** — ingest, analyze, investigate, recommend, approve.
2. **Creative Experiment Loop** — research, hypothesize, generate, validate, approve, publish, measure, learn.
3. **Experimentation Loop** — define hypothesis, design test, execute, measure, estimate causal effect, record learning.

## 4. Acquisition scope

The platform is channel-neutral. Digital and physical acquisition are execution surfaces, not separate product domains.

Initial/near-term channel categories:

- paid media;
- search/content;
- CRM/email;
- website/conversion;
- social/content;
- field acquisition.

Specific providers remain outside the core domain behind extensions/adapters.

## 5. Field-agent scope

Field agents are human participants who can:

- register as platform users;
- declare geography, availability, capabilities, and preferences;
- receive eligible jobs;
- accept or decline jobs;
- execute visits or other physical acquisition work;
- submit structured outcomes and evidence;
- maintain continuity with prospects when assigned by policy.

Agencies may use their own staff or the platform field-agent pool.

## 6. Prove-it-first commercial motion

The platform supports bounded acquisition pilots before a long-form agency contract. A pilot produces measurable evidence of acquisition performance; the commercial contract is external business policy and does not become a second workflow engine.

## 7. Explicit exclusions for v1 architecture

The following are not separate core products or authorities:

- CRM replacement;
- generic enterprise search;
- generic autonomous agent marketplace;
- agent-swarm framework;
- model-provider-specific business logic;
- a permanent VM per client or agent;
- a second workflow/orchestration engine;
- attribution treated as causal truth;
- automated scraping as a core authority;
- autonomous high-risk external communications without policy gates.

These may be introduced through extensions or later architecture versions without changing the core domain model.
