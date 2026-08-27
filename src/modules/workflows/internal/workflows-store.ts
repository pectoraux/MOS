/**
 * /workflows persistence (workflows + workflow_definitions tables).
 *
 * DB backstops (migration 009 + implementation-contract §3, §25):
 *   - Workflow identity + Workspace scope + the server-derived Client and
 *     Agency ownership are IMMUTABLE (trigger) — a Workflow can never cross
 *     the Workspace, Client or Agency boundary;
 *   - the scope-chain trigger rejects a workspace outside the recorded
 *     Client and a client outside the recorded Agency on INSERT and UPDATE;
 *   - the explicit version identity (workflow_definition_id, workflow_id,
 *     version_number), the playbook provenance link and provenance are
 *     IMMUTABLE (trigger), and (workflow_id, version_number) is
 *     UNIQUE-fenced — a version number is assigned exactly once per
 *     workflow;
 *   - the playbook-provenance scope trigger rejects an unknown playbook
 *     version or one not usable by the workflow's Client (Agency-scoped
 *     reusable IP or the SAME Client);
 *   - ACTIVATED definitions reject every content change (trigger), the
 *     only legal transition being the content-preserving active → retired;
 *     RETIRED rows are fully frozen terminal history ("A Workflow
 *     Definition is versioned and immutable after activation");
 *   - every mutable row carries a version CAS token (row-locked
 *     transitions).
 *
 * No uniqueness fence on workflow names: workflows are append-oriented
 * versioned artifacts, and concurrent creation is serialized by
 * server-generated identity, not by content.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  WorkflowCompensationDeclaration,
  WorkflowConcurrencyLimits,
  WorkflowDefinitionContent,
  WorkflowDefinitionRecord,
  WorkflowDefinitionStatus,
  WorkflowEdge,
  WorkflowEdgeType,
  WorkflowGraph,
  WorkflowHumanApproval,
  WorkflowIdempotencyKeyStrategy,
  WorkflowInputMapping,
  WorkflowJoinContract,
  WorkflowLoopContract,
  WorkflowNode,
  WorkflowNodeRetryPolicy,
  WorkflowNodeTimeout,
  WorkflowRecord,
  WorkflowRetryPolicyDefaults,
  WorkflowSchemaProperty,
  WorkflowSchemaShape,
  WorkflowTimeoutPolicy,
} from '../public.ts';

interface WorkflowRow extends DbRow {
  workflow_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  name: string;
  description: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowDefinitionRow extends DbRow {
  workflow_definition_id: string;
  workflow_id: string;
  version_number: number | string;
  status: string;
  playbook_version_id: string | null;
  graph: unknown;
  input_schema: unknown;
  output_schema: unknown;
  retry_policy_defaults: unknown;
  concurrency_limits: unknown;
  timeout_policy: unknown;
  compensation: unknown;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

const WORKFLOW_SELECT = `
  SELECT workflow_id, workspace_id, client_id, agency_id, name, description,
         created_by, version, created_at, updated_at
  FROM workflows
`;

const WORKFLOW_DEFINITION_SELECT = `
  SELECT workflow_definition_id, workflow_id, version_number, status,
         playbook_version_id, graph, input_schema, output_schema,
         retry_policy_defaults, concurrency_limits, timeout_policy, compensation,
         created_by, version, created_at, updated_at
  FROM workflow_definitions
`;

export class WorkflowsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  async insertWorkflow(input: {
    workspaceId: string;
    clientId: string;
    agencyId: string;
    name: string;
    description: string;
    actorId: string | null;
  }): Promise<WorkflowRecord> {
    const workflowId = this.ids.newId();
    const now = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO workflows (workflow_id, workspace_id, client_id, agency_id, name, description,
                              created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        workflowId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.name,
        input.description,
        input.actorId,
        now,
      ],
    );
    const created = await this.getWorkflow(workflowId);
    if (created === null) {
      throw new Error(`inserted workflow ${workflowId} could not be read back`);
    }
    return created;
  }

  async getWorkflow(workflowId: string): Promise<WorkflowRecord | null> {
    const result = await this.db.query<WorkflowRow>(`${WORKFLOW_SELECT} WHERE workflow_id = $1`, [
      workflowId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowRecord(row);
  }

  async listWorkflowsForWorkspace(workspaceId: string): Promise<readonly WorkflowRecord[]> {
    const result = await this.db.query<WorkflowRow>(
      `${WORKFLOW_SELECT} WHERE workspace_id = $1 ORDER BY created_at, workflow_id`,
      [workspaceId],
    );
    return result.rows.map(toWorkflowRecord);
  }

  /** Locks the workflow row (FOR UPDATE) and returns it — CAS serialized. */
  async lockWorkflow(tx: DbTransaction, workflowId: string): Promise<WorkflowRecord | null> {
    const result = await tx.query<WorkflowRow>(`${WORKFLOW_SELECT} WHERE workflow_id = $1 FOR UPDATE`, [
      workflowId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowRecord(row);
  }

  /** CAS container profile mutation on the CALLER'S transaction (row locked there). */
  async updateWorkflowProfileRow(
    tx: DbTransaction,
    input: { workflowId: string; name: string; description: string; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE workflows SET name = $1, description = $2, version = version + 1, updated_at = $3
       WHERE workflow_id = $4 AND version = $5`,
      [input.name, input.description, now, input.workflowId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'workflows', 'workflow_id', input.workflowId);
  }

  /**
   * Inserts the next definition version with the SERVER-ASSIGNED
   * per-workflow monotonic version number. MUST run on a transaction that
   * already holds the workflow row lock (lockWorkflow) — that lock
   * serializes version-number assignment, so concurrent creates get
   * distinct sequential numbers and the UNIQUE fence can never fire in
   * ordinary operation.
   */
  async insertWorkflowDefinition(
    tx: DbTransaction,
    input: {
      workflowId: string;
      content: WorkflowDefinitionContent;
      playbookVersionId: string | null;
      actorId: string | null;
    },
  ): Promise<WorkflowDefinitionRecord> {
    const definitionId = this.ids.newId();
    const now = this.clock.nowIso();
    const next = await tx.query<{ next_number: number | string }>(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number FROM workflow_definitions WHERE workflow_id = $1',
      [input.workflowId],
    );
    const versionNumber = Number(next.rows[0]?.next_number ?? 1);
    await tx.query(
      `INSERT INTO workflow_definitions (workflow_definition_id, workflow_id, version_number, status,
                                          playbook_version_id, graph, input_schema, output_schema,
                                          retry_policy_defaults, concurrency_limits, timeout_policy,
                                          compensation, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'draft', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::jsonb, $11::jsonb, $12, $13, $13)`,
      [
        definitionId,
        input.workflowId,
        versionNumber,
        input.playbookVersionId,
        JSON.stringify(input.content.graph),
        JSON.stringify(input.content.inputSchema),
        JSON.stringify(input.content.outputSchema),
        JSON.stringify(input.content.retryPolicyDefaults),
        JSON.stringify(input.content.concurrencyLimits),
        JSON.stringify(input.content.timeoutPolicy),
        JSON.stringify(input.content.compensation),
        input.actorId,
        now,
      ],
    );
    // Read back THROUGH THE CALLER'S TRANSACTION — the row is not visible
    // to other connections until the transaction commits.
    const created = await tx.query<WorkflowDefinitionRow>(
      `${WORKFLOW_DEFINITION_SELECT} WHERE workflow_definition_id = $1`,
      [definitionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted workflow definition ${definitionId} could not be read back`);
    }
    return toWorkflowDefinitionRecord(row);
  }

  async getWorkflowDefinition(definitionId: string): Promise<WorkflowDefinitionRecord | null> {
    const result = await this.db.query<WorkflowDefinitionRow>(
      `${WORKFLOW_DEFINITION_SELECT} WHERE workflow_definition_id = $1`,
      [definitionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowDefinitionRecord(row);
  }

  async listWorkflowDefinitions(workflowId: string): Promise<readonly WorkflowDefinitionRecord[]> {
    const result = await this.db.query<WorkflowDefinitionRow>(
      `${WORKFLOW_DEFINITION_SELECT} WHERE workflow_id = $1 ORDER BY version_number`,
      [workflowId],
    );
    return result.rows.map(toWorkflowDefinitionRecord);
  }

  /** Locks the definition row (FOR UPDATE) and returns it — CAS serialized. */
  async lockWorkflowDefinition(
    tx: DbTransaction,
    definitionId: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    const result = await tx.query<WorkflowDefinitionRow>(
      `${WORKFLOW_DEFINITION_SELECT} WHERE workflow_definition_id = $1 FOR UPDATE`,
      [definitionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWorkflowDefinitionRecord(row);
  }

  /** CAS definition content mutation on the CALLER'S transaction (row locked there). */
  async updateWorkflowDefinitionContentRow(
    tx: DbTransaction,
    input: { definitionId: string; content: WorkflowDefinitionContent; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE workflow_definitions SET graph = $1::jsonb, input_schema = $2::jsonb,
                                        output_schema = $3::jsonb, retry_policy_defaults = $4::jsonb,
                                        concurrency_limits = $5::jsonb, timeout_policy = $6::jsonb,
                                        compensation = $7::jsonb, version = version + 1, updated_at = $8
       WHERE workflow_definition_id = $9 AND version = $10`,
      [
        JSON.stringify(input.content.graph),
        JSON.stringify(input.content.inputSchema),
        JSON.stringify(input.content.outputSchema),
        JSON.stringify(input.content.retryPolicyDefaults),
        JSON.stringify(input.content.concurrencyLimits),
        JSON.stringify(input.content.timeoutPolicy),
        JSON.stringify(input.content.compensation),
        now,
        input.definitionId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'workflow_definitions', 'workflow_definition_id', input.definitionId);
  }

  /** CAS definition lifecycle mutation on the CALLER'S transaction (row locked there). */
  async updateWorkflowDefinitionStatusRow(
    tx: DbTransaction,
    input: { definitionId: string; status: WorkflowDefinitionStatus; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE workflow_definitions SET status = $1, version = version + 1, updated_at = $2
       WHERE workflow_definition_id = $3 AND version = $4`,
      [input.status, now, input.definitionId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, 'workflow_definitions', 'workflow_definition_id', input.definitionId);
  }
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  table: 'workflows' | 'workflow_definitions',
  idColumn: 'workflow_id' | 'workflow_definition_id',
  id: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    `SELECT version FROM ${table} WHERE ${idColumn} = $1`,
    [id],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

function toWorkflowRecord(row: WorkflowRow): WorkflowRecord {
  return {
    workflowId: row.workflow_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toWorkflowDefinitionRecord(row: WorkflowDefinitionRow): WorkflowDefinitionRecord {
  return {
    workflowDefinitionId: row.workflow_definition_id,
    workflowId: row.workflow_id,
    versionNumber: Number(row.version_number),
    status: row.status as WorkflowDefinitionStatus,
    playbookVersionId: row.playbook_version_id,
    content: parseDefinitionContent(row),
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * jsonb rows arrive as already-parsed JSON. The shapes were exhaustively
 * validated at write time (route envelope validation + the module's graph
 * authority validation + DB CHECKs); these parsers are defensive
 * normalizers, never authority.
 */
function parseDefinitionContent(row: WorkflowDefinitionRow): WorkflowDefinitionContent {
  return {
    graph: parseGraph(row.graph),
    inputSchema: parseSchema(row.input_schema),
    outputSchema: parseSchema(row.output_schema),
    retryPolicyDefaults: parseRetryDefaults(row.retry_policy_defaults),
    concurrencyLimits: parseConcurrencyLimits(row.concurrency_limits),
    timeoutPolicy: parseTimeoutPolicy(row.timeout_policy),
    compensation: parseCompensation(row.compensation),
  };
}

function parseGraph(raw: unknown): WorkflowGraph {
  const record = asRecord(raw);
  const nodes = Array.isArray(record['nodes']) ? record['nodes'] : [];
  const edges = Array.isArray(record['edges']) ? record['edges'] : [];
  return {
    nodes: nodes.map((item): WorkflowNode => {
      const node = asRecord(item);
      return {
        nodeId: typeof node['nodeId'] === 'string' ? node['nodeId'] : '',
        nodeType: node['nodeType'] as WorkflowNode['nodeType'],
        inputMapping: parseInputMapping(node['inputMapping']),
        outputSchema: parseSchema(node['outputSchema']),
        executionPolicyRef: optionalString(node['executionPolicyRef']),
        retryPolicy: parseNodeRetryPolicy(node['retryPolicy']),
        timeout: parseNodeTimeout(node['timeout']),
        idempotencyKeyStrategy: parseIdempotencyStrategy(node['idempotencyKeyStrategy']),
        humanApproval: parseHumanApproval(node['humanApproval']),
        join: parseJoinContract(node['join']),
        loop: parseLoopContract(node['loop']),
      };
    }),
    edges: edges.map((item): WorkflowEdge => {
      const edge = asRecord(item);
      return {
        fromNode: typeof edge['fromNode'] === 'string' ? edge['fromNode'] : '',
        toNode: typeof edge['toNode'] === 'string' ? edge['toNode'] : '',
        edgeType: edge['edgeType'] as WorkflowEdgeType,
        predicateRef: optionalString(edge['predicateRef']),
        joinSemantics:
          edge['joinSemantics'] === 'all' || edge['joinSemantics'] === 'any'
            ? edge['joinSemantics']
            : null,
      };
    }),
  };
}

function parseInputMapping(raw: unknown): Readonly<Record<string, WorkflowInputMapping>> {
  const record = asRecord(raw);
  const mapping: Record<string, WorkflowInputMapping> = {};
  for (const [field, value] of Object.entries(record)) {
    const source = asRecord(value);
    if (source['source'] === 'workflow_input') {
      mapping[field] = {
        source: 'workflow_input',
        path: typeof source['path'] === 'string' ? source['path'] : '',
      };
    } else {
      mapping[field] = {
        source: 'node_output',
        nodeId: typeof source['nodeId'] === 'string' ? source['nodeId'] : '',
        path: typeof source['path'] === 'string' ? source['path'] : '',
      };
    }
  }
  return mapping;
}

function parseSchema(raw: unknown): WorkflowSchemaShape {
  const record = asRecord(raw);
  const properties = asRecord(record['properties']);
  const normalized: Record<string, WorkflowSchemaProperty> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = asRecord(value);
    normalized[name] = {
      type: property['type'] as WorkflowSchemaProperty['type'],
      description: optionalString(property['description']),
    };
  }
  const required = Array.isArray(record['required'])
    ? record['required'].filter((item): item is string => typeof item === 'string')
    : [];
  return { type: 'object', properties: normalized, required };
}

function parseNodeRetryPolicy(raw: unknown): WorkflowNodeRetryPolicy | null {
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw);
  return {
    maxAttempts: typeof record['maxAttempts'] === 'number' ? record['maxAttempts'] : 1,
    backoffMs: optionalNumber(record['backoffMs']),
  };
}

function parseNodeTimeout(raw: unknown): WorkflowNodeTimeout | null {
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw);
  return {
    seconds: typeof record['seconds'] === 'number' ? record['seconds'] : 1,
  };
}

function parseIdempotencyStrategy(raw: unknown): WorkflowIdempotencyKeyStrategy | null {
  if (raw === 'workflow' || raw === 'node' || raw === 'none') return raw;
  return null;
}

function parseHumanApproval(raw: unknown): WorkflowHumanApproval | null {
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw);
  if (record['required'] !== true) return null;
  return { required: true, approverPolicyRef: optionalString(record['approverPolicyRef']) };
}

function parseJoinContract(raw: unknown): WorkflowJoinContract | null {
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw);
  const predecessors = Array.isArray(record['predecessors'])
    ? record['predecessors'].filter((item): item is string => typeof item === 'string')
    : [];
  return {
    semantics: record['semantics'] === 'any' ? 'any' : 'all',
    predecessors,
    threshold: optionalNumber(record['threshold']),
  };
}

function parseLoopContract(raw: unknown): WorkflowLoopContract | null {
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw);
  const termination = asRecord(record['termination']);
  return {
    maxIterations: typeof record['maxIterations'] === 'number' ? record['maxIterations'] : 1,
    termination: {
      kind: termination['kind'] === 'predicate' ? 'predicate' : 'count',
      predicateRef: optionalString(termination['predicateRef']),
    },
  };
}

function parseRetryDefaults(raw: unknown): WorkflowRetryPolicyDefaults {
  const record = asRecord(raw);
  return {
    maxAttempts: optionalNumber(record['maxAttempts']),
    backoffMs: optionalNumber(record['backoffMs']),
  };
}

function parseConcurrencyLimits(raw: unknown): WorkflowConcurrencyLimits {
  const record = asRecord(raw);
  return {
    maxConcurrentWorkflows: optionalNumber(record['maxConcurrentWorkflows']),
    maxConcurrentNodes: optionalNumber(record['maxConcurrentNodes']),
  };
}

function parseTimeoutPolicy(raw: unknown): WorkflowTimeoutPolicy {
  const record = asRecord(raw);
  return {
    defaultTimeoutSeconds: optionalNumber(record['defaultTimeoutSeconds']),
    maxTimeoutSeconds: optionalNumber(record['maxTimeoutSeconds']),
  };
}

function parseCompensation(raw: unknown): readonly WorkflowCompensationDeclaration[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item): WorkflowCompensationDeclaration => {
    const entry = asRecord(item);
    return {
      nodeId: typeof entry['nodeId'] === 'string' ? entry['nodeId'] : '',
      compensateViaNodeId:
        typeof entry['compensateViaNodeId'] === 'string' ? entry['compensateViaNodeId'] : '',
    };
  });
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function optionalString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function optionalNumber(raw: unknown): number | null {
  return typeof raw === 'number' ? raw : null;
}
