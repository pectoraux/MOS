# Extension Model

**Status:** FROZEN

## 1. Purpose

Extensions allow third-party developers and internal teams to add capabilities without coupling the core domain to every provider or acquisition mechanism.

The model is intentionally analogous to an app/extension ecosystem: versioned package, declared capabilities, permissions, configuration, runtime requirements, lifecycle hooks, and UI surfaces.

## 2. Extension manifest

An extension declares:

- identifier and publisher;
- version;
- compatibility range;
- capability list;
- permissions;
- required secrets by logical name;
- data scopes;
- network requirements;
- runtime class;
- input/output contracts;
- event subscriptions;
- UI surfaces;
- pricing metadata where applicable.

## 3. Capability categories

Extensions may provide:

- data source;
- research/discovery;
- content/creative generation;
- execution action;
- measurement;
- CRM/commerce integration;
- field acquisition capability;
- AI capability;
- approval/UI surface.

## 4. Lifecycle

```text
Develop
 → Validate
 → Publish
 → Install
 → Configure
 → Authorize
 → Invoke
 → Observe
 → Version / Disable / Uninstall
```

## 5. Permissions

Permissions are explicit and least-privilege. The extension receives only the data/actions needed for the invocation.

Extensions cannot:

- read unrelated client data;
- bypass workflow policy;
- write authoritative workflow state directly;
- create credentials for themselves;
- manufacture evidence provenance;
- disable audit;
- invoke arbitrary network access without declared policy support.

## 6. Scraping

Scraping is an extension class, not a core platform authority. Scraper outputs are observations with source, timestamp, retrieval method, and provider/extension identity. Compliance, terms, privacy, and rate limits are extension/platform policy concerns.

## 7. Full-lifecycle participation

An extension may participate in:

```text
Discover → Plan → Create → Execute → Measure → Learn
```

but every mutation remains inside the authoritative workflow/evidence/audit/policy boundaries.
