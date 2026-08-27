# Creator Operations Domain Pack — v1.3

**Status:** FROZEN
**Pack:** Creator Operations

## 1. Purpose

Creator Operations specializes MarketingOS for agencies managing creators, creator accounts, audience engagement, content, growth, and monetization operations.

It is a Domain Pack, not a separate product or execution engine.

## 2. Core subjects

Creator Operations may model Client-scoped domain subjects such as:

- Creator Profile;
- Creator Account;
- Audience Member / Fan;
- Conversation;
- Content Asset;
- Offer;
- Engagement Event;
- Monetization Event;
- Creator Performance Metric.

These are pack-owned records. The Client remains the hard security boundary.

## 3. Supported operating workflows

The pack may provide governed workflows for:

- audience segmentation;
- conversation triage and response drafting;
- human chat operations;
- creator content planning/repurposing;
- growth experiments;
- fan reactivation;
- offer testing;
- revenue analysis;
- creator-manager task assignment;
- client/creator reporting and approvals.

## 4. Human roles

Creator Operations may define Human Agent specializations including:

- Creator Manager;
- Chatter;
- Content Manager;
- Growth Manager;
- Account Manager;
- Reviewer.

They use the generic Human Agent → Job → Task → Execution model.

## 5. AI use

AI tasks must use the platform TaskProfile and AI Router. Typical task classes include classification, retrieval/synthesis, response drafting, content generation, conversation summarization, segmentation, and recommendation.

Sensitive or high-risk operations must use Policy and human approval gates according to Client/Agency configuration.

## 6. Creator platform integrations

Creator platforms are external systems. The pack may bind normalized capabilities such as:

- read creator/account metrics;
- read audience/fan records;
- read conversations/events;
- send an approved communication;
- publish approved content;
- read monetization/transaction observations;
- receive provider events/webhooks.

Provider-specific APIs, browser automation, scraping, or vendor SDKs MUST live behind the Integration/Extension boundaries.

No creator platform becomes the MarketingOS system of record for workflow, evidence, policy, or execution state.

## 7. Evidence and learning

Creator-performance observations, human interaction records, provider events, experiments, and business outcomes enter the common Evidence/Measurement/Experiment/Learning architecture. Attribution must not be presented as causal lift without a qualifying design.

## 8. Privacy boundary

Raw fan/audience/conversation data remains Client-scoped. Cross-client learning may use only explicitly governed aggregated or derived information and must not expose raw Client records.
