/**
 * /workflows graph validation (MKT-008) — the typed Workflow Graph authority.
 *
 * Pure, deterministic validation of a Workflow Definition's content against
 * the frozen contracts:
 *
 *   - implementation-contract §4 (workflow definition contract): node
 *     definitions, edge definitions, input/output schemas, policy blocks;
 *     "Workflow validation MUST reject dangling nodes/edges, invalid node
 *     types, impossible joins, duplicate node IDs, illegal cycles, and
 *     unresolved schema mappings. Cycles are allowed only where an explicit
 *     bounded loop construct declares its iteration/termination contract."
 *   - architecture.md §10 (Workflow Graph): the frozen node class list and
 *     "Graph cycles require an explicit bounded loop contract."
 *
 * The validator is the AUTHORITY: it runs inside the /workflows module on
 * every create and every content update, whatever the caller did upstream.
 * It accepts `unknown` and produces a complete, deterministic problem list
 * (never fail-fast — operators see every defect at once).
 *
 * Cycle rule formalization ("illegal cycles" / "explicit bounded loops"):
 * a cycle is legal ONLY when it passes through a `loop` node carrying an
 * explicit bounded loop contract. Equivalently: the graph with ALL loop
 * nodes removed must be ACYCLIC — any cycle avoiding every loop node
 * survives the removal and is rejected. Loop-node returns are additionally
 * fenced: a loop node may receive at most ONE edge from OUTSIDE its own
 * cyclic region (the single entry) — every other incoming edge must be an
 * iteration return from inside the region.
 *
 * Join rule formalization ("impossible joins" / "join semantics"): any
 * node with more than one incoming edge must be a `join` node (explicit
 * join contract) or a `loop` node (entry + iteration returns). A join's
 * declared predecessor set must EXACTLY equal the set of its join-edge
 * sources, must contain at least two distinct predecessors, every declared
 * predecessor must be reachable from a graph entry (a join that can never
 * release is impossible), and thresholds must be satisfiable.
 */

import type {
  WorkflowEdge,
  WorkflowEdgeType,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowSchemaProperty,
  WorkflowSchemaShape,
} from '../public.ts';
import {
  EXECUTABLE_NODE_TYPES,
  STRUCTURAL_NODE_TYPES,
  WORKFLOW_EDGE_TYPES,
  WORKFLOW_NODE_TYPES,
} from '../public.ts';

/** Server-side structural bounds (documented policy: bounded graphs). */
export const WORKFLOW_MAX_NODES = 200;
export const WORKFLOW_MAX_EDGES = 500;
export const WORKFLOW_MAX_JOIN_PREDECESSORS = 50;
export const WORKFLOW_MAX_LOOP_ITERATIONS = 10_000;
export const WORKFLOW_MAX_MAPPING_FIELDS = 50;
export const WORKFLOW_MAX_SCHEMA_PROPERTIES = 100;
export const WORKFLOW_MAX_COMPENSATION_ENTRIES = 100;
const MAX_TIMEOUT_SECONDS = 2_592_000; // 30 days
const MAX_ATTEMPTS = 100;
const MAX_BACKOFF_MS = 3_600_000; // 1 hour
const MAX_CONCURRENCY = 10_000;
const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF_MAX_LENGTH = 200;

const PROPERTY_TYPES: readonly string[] = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
];

type Problems = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Validates a complete Workflow Definition content object (graph + schemas
 * + policy blocks). Returns EVERY problem found, in deterministic order;
 * an empty list means the content is a legal typed workflow graph.
 */
export function validateWorkflowDefinitionContent(content: unknown): readonly string[] {
  const problems: Problems = [];
  if (!isRecord(content)) {
    return ['workflow definition: must be an object'];
  }

  validateGraph(content['graph'], problems);
  const graph = extractGraph(content['graph']);
  validateSchemaShape(content['inputSchema'], 'inputSchema', problems);
  validateSchemaShape(content['outputSchema'], 'outputSchema', problems);
  const inputSchema = extractSchemaShape(content['inputSchema']);
  validateRetryPolicyDefaults(content['retryPolicyDefaults'], problems);
  validateConcurrencyLimits(content['concurrencyLimits'], problems);
  validateTimeoutPolicy(content['timeoutPolicy'], problems);
  validateCompensation(content['compensation'], graph, problems);

  if (graph !== null) {
    validateGraphStructure(graph, inputSchema, problems);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Graph shape (typed node/edge contracts)
// ---------------------------------------------------------------------------

function extractGraph(raw: unknown): WorkflowGraph | null {
  if (!isRecord(raw)) return null;
  const nodes = raw['nodes'];
  const edges = raw['edges'];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
  return { nodes: nodes as unknown as WorkflowNode[], edges: edges as unknown as WorkflowEdge[] };
}

function validateGraph(raw: unknown, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push('graph: must be an object with nodes and edges');
    return;
  }
  const nodes = raw['nodes'];
  const edges = raw['edges'];
  if (!Array.isArray(nodes)) {
    problems.push('graph.nodes: must be an array of node definitions');
  } else if (nodes.length === 0) {
    problems.push('graph.nodes: at least one node is required');
  } else if (nodes.length > WORKFLOW_MAX_NODES) {
    problems.push(`graph.nodes: at most ${WORKFLOW_MAX_NODES} nodes are allowed`);
  } else {
    nodes.forEach((node, index) => validateNodeShape(node, `graph.nodes[${index}]`, problems));
  }
  if (!Array.isArray(edges)) {
    problems.push('graph.edges: must be an array of edge definitions');
  } else if (edges.length > WORKFLOW_MAX_EDGES) {
    problems.push(`graph.edges: at most ${WORKFLOW_MAX_EDGES} edges are allowed`);
  } else {
    edges.forEach((edge, index) => validateEdgeShape(edge, `graph.edges[${index}]`, problems));
  }
}

function validateNodeShape(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  const nodeId = raw['nodeId'];
  if (!isPlainString(nodeId) || !ID_PATTERN.test(nodeId) || nodeId.length > 100) {
    problems.push(`${path}.nodeId: a non-empty identifier (letters, digits, _, -; max 100 chars) is required`);
  }
  const nodeType = raw['nodeType'];
  if (!isPlainString(nodeType) || !WORKFLOW_NODE_TYPES.includes(nodeType as WorkflowNodeType)) {
    problems.push(
      `${path}.nodeType: must be one of the frozen node classes (${WORKFLOW_NODE_TYPES.join(', ')})`,
    );
  }

  const type = WORKFLOW_NODE_TYPES.includes(nodeType as WorkflowNodeType)
    ? (nodeType as WorkflowNodeType)
    : null;
  const structural = type !== null && STRUCTURAL_NODE_TYPES.includes(type);
  // Control-flow nodes (condition/join/loop) consume no inputs; the terminal
  // OUTCOME RECORDER does — it maps the upstream outputs it records.
  const control = type === 'condition' || type === 'join' || type === 'loop';

  // Input mapping: an object of field → source mapping (control-flow nodes
  // consume no inputs — they produce no work and pass no data).
  const mapping = raw['inputMapping'];
  if (!isRecord(mapping)) {
    problems.push(`${path}.inputMapping: must be an object of field → source mappings`);
  } else {
    const keys = Object.keys(mapping);
    if (keys.length > WORKFLOW_MAX_MAPPING_FIELDS) {
      problems.push(`${path}.inputMapping: at most ${WORKFLOW_MAX_MAPPING_FIELDS} fields are allowed`);
    }
    if (control && keys.length > 0) {
      problems.push(
        `${path}.inputMapping: control nodes (condition, join, loop) consume no inputs`,
      );
    }
    keys.forEach((key) => {
      if (key.trim() === '' || key.length > 100) {
        problems.push(`${path}.inputMapping: field names must be non-empty (max 100 chars)`);
      }
      validateInputMapping(mapping[key], `${path}.inputMapping.${key}`, problems);
    });
  }

  validateSchemaShape(raw['outputSchema'], `${path}.outputSchema`, problems);

  // Execution-policy reference: executable nodes only, non-empty when set.
  const executionPolicyRef = raw['executionPolicyRef'];
  if (executionPolicyRef !== undefined && executionPolicyRef !== null) {
    if (!isPlainString(executionPolicyRef) || executionPolicyRef.trim() === '' || executionPolicyRef.length > REF_MAX_LENGTH) {
      problems.push(`${path}.executionPolicyRef: must be a non-empty policy reference (max ${REF_MAX_LENGTH} chars)`);
    }
    if (structural) {
      problems.push(
        `${path}.executionPolicyRef: structural control nodes execute nothing and carry no execution policy`,
      );
    }
  }

  // Retry policy: executable nodes only.
  const retryPolicy = raw['retryPolicy'];
  if (retryPolicy !== undefined && retryPolicy !== null) {
    validateNodeRetryPolicy(retryPolicy, `${path}.retryPolicy`, problems);
    if (structural) {
      problems.push(`${path}.retryPolicy: structural control nodes produce no work and never retry`);
    }
  }

  // Timeout: executable nodes only.
  const timeout = raw['timeout'];
  if (timeout !== undefined && timeout !== null) {
    validateNodeTimeout(timeout, `${path}.timeout`, problems);
    if (structural) {
      problems.push(`${path}.timeout: structural control nodes produce no work and never time out`);
    }
  }

  // Idempotency key strategy: executable nodes only.
  const idempotencyKeyStrategy = raw['idempotencyKeyStrategy'];
  if (idempotencyKeyStrategy !== undefined && idempotencyKeyStrategy !== null) {
    if (
      !isPlainString(idempotencyKeyStrategy) ||
      !['workflow', 'node', 'none'].includes(idempotencyKeyStrategy)
    ) {
      problems.push(`${path}.idempotencyKeyStrategy: must be one of workflow, node, none`);
    }
    if (structural) {
      problems.push(
        `${path}.idempotencyKeyStrategy: structural control nodes produce no work and need no idempotency key`,
      );
    }
  }

  // Human approval requirement: REQUIRED on human-class nodes, FORBIDDEN
  // everywhere else (implementation-contract §4 "human approval
  // requirement if applicable").
  const humanApproval = raw['humanApproval'];
  const humanClass = type === 'human_task' || type === 'approval';
  if (humanApproval !== undefined && humanApproval !== null) {
    validateHumanApproval(humanApproval, `${path}.humanApproval`, problems);
    if (!humanClass) {
      problems.push(
        `${path}.humanApproval: only human_task and approval nodes carry a human approval requirement`,
      );
    }
  } else if (humanClass) {
    problems.push(
      `${path}.humanApproval: human_task and approval nodes must declare their human approval requirement`,
    );
  }

  // Join contract: REQUIRED on join nodes, FORBIDDEN everywhere else.
  const join = raw['join'];
  if (join !== undefined && join !== null) {
    if (type !== 'join') {
      problems.push(`${path}.join: only join nodes carry a join contract`);
    } else {
      validateJoinContract(join, `${path}.join`, problems);
    }
  } else if (type === 'join') {
    problems.push(`${path}.join: join nodes must declare their converging-branch join semantics`);
  }

  // Loop contract: REQUIRED on loop nodes, FORBIDDEN everywhere else.
  const loop = raw['loop'];
  if (loop !== undefined && loop !== null) {
    if (type !== 'loop') {
      problems.push(`${path}.loop: only loop nodes carry a bounded loop contract`);
    } else {
      validateLoopContract(loop, `${path}.loop`, problems);
    }
  } else if (type === 'loop') {
    problems.push(
      `${path}.loop: loop nodes must declare their explicit bounded iteration/termination contract`,
    );
  }

}

function validateEdgeShape(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  const fromNode = raw['fromNode'];
  if (!isPlainString(fromNode) || !ID_PATTERN.test(fromNode) || fromNode.length > 100) {
    problems.push(`${path}.fromNode: a non-empty node identifier is required`);
  }
  const toNode = raw['toNode'];
  if (!isPlainString(toNode) || !ID_PATTERN.test(toNode) || toNode.length > 100) {
    problems.push(`${path}.toNode: a non-empty node identifier is required`);
  }
  const edgeType = raw['edgeType'];
  if (!isPlainString(edgeType) || !WORKFLOW_EDGE_TYPES.includes(edgeType as WorkflowEdgeType)) {
    problems.push(
      `${path}.edgeType: must be one of the frozen edge types (${WORKFLOW_EDGE_TYPES.join(', ')})`,
    );
  }
  const predicateRef = raw['predicateRef'];
  const type = WORKFLOW_EDGE_TYPES.includes(edgeType as WorkflowEdgeType)
    ? (edgeType as WorkflowEdgeType)
    : null;
  if (type === 'conditional') {
    if (!isPlainString(predicateRef) || predicateRef.trim() === '' || predicateRef.length > REF_MAX_LENGTH) {
      problems.push(
        `${path}.predicateRef: conditional edges must carry a non-empty predicate reference (max ${REF_MAX_LENGTH} chars)`,
      );
    }
  } else if (predicateRef !== undefined && predicateRef !== null) {
    problems.push(`${path}.predicateRef: only conditional edges carry a predicate reference`);
  }
  const joinSemantics = raw['joinSemantics'];
  if (type === 'join') {
    if (joinSemantics !== 'all' && joinSemantics !== 'any') {
      problems.push(`${path}.joinSemantics: join edges must mirror the join node semantics (all or any)`);
    }
  } else if (joinSemantics !== undefined && joinSemantics !== null) {
    problems.push(`${path}.joinSemantics: only join edges carry join semantics`);
  }
}

function validateInputMapping(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be a mapping source object`);
    return;
  }
  const source = raw['source'];
  if (source === 'workflow_input') {
    if (!isPlainString(raw['path']) || !isValidMappingPath(raw['path'])) {
      problems.push(`${path}.path: a dot-separated property path is required`);
    }
  } else if (source === 'node_output') {
    if (!isPlainString(raw['nodeId']) || !ID_PATTERN.test(raw['nodeId']) || raw['nodeId'].length > 100) {
      problems.push(`${path}.nodeId: a non-empty source node identifier is required`);
    }
    if (!isPlainString(raw['path']) || !isValidMappingPath(raw['path'])) {
      problems.push(`${path}.path: a dot-separated property path is required`);
    }
  } else {
    problems.push(`${path}.source: must be workflow_input or node_output`);
  }
}

function isValidMappingPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  const segments = path.split('.');
  if (segments.length > 8) return false;
  return segments.every((segment) => PATH_SEGMENT_PATTERN.test(segment));
}

function validateHumanApproval(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  if (raw['required'] !== true) {
    problems.push(`${path}.required: a human approval requirement is only expressible as required: true`);
  }
  const approverPolicyRef = raw['approverPolicyRef'];
  if (
    approverPolicyRef !== undefined &&
    approverPolicyRef !== null &&
    (!isPlainString(approverPolicyRef) || approverPolicyRef.trim() === '' || approverPolicyRef.length > REF_MAX_LENGTH)
  ) {
    problems.push(`${path}.approverPolicyRef: must be a non-empty policy reference (max ${REF_MAX_LENGTH} chars)`);
  }
}

function validateJoinContract(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  const semantics = raw['semantics'];
  if (semantics !== 'all' && semantics !== 'any') {
    problems.push(`${path}.semantics: must be all or any`);
  }
  const predecessors = raw['predecessors'];
  if (!Array.isArray(predecessors)) {
    problems.push(`${path}.predecessors: must be an array of converging predecessor node ids`);
  } else {
    if (predecessors.length < 2) {
      problems.push(`${path}.predecessors: a join converges at least two branches`);
    }
    if (predecessors.length > WORKFLOW_MAX_JOIN_PREDECESSORS) {
      problems.push(`${path}.predecessors: at most ${WORKFLOW_MAX_JOIN_PREDECESSORS} predecessors are allowed`);
    }
    const seen = new Set<string>();
    predecessors.forEach((nodeId) => {
      if (!isPlainString(nodeId) || !ID_PATTERN.test(nodeId)) {
        problems.push(`${path}.predecessors: node identifiers must be non-empty`);
      } else if (seen.has(nodeId)) {
        problems.push(`${path}.predecessors: duplicate predecessor ${nodeId}`);
      } else {
        seen.add(nodeId);
      }
    });
  }
  const threshold = raw['threshold'];
  const count = Array.isArray(predecessors) ? predecessors.length : 0;
  if (threshold !== undefined && threshold !== null) {
    if (typeof threshold !== 'number' || !Number.isInteger(threshold)) {
      problems.push(`${path}.threshold: must be an integer`);
    } else if (semantics === 'all' && threshold !== count) {
      problems.push(
        `${path}.threshold: an all-join releases exactly when every predecessor arrived (threshold must equal ${count} or be absent)`,
      );
    } else if (semantics === 'any' && (threshold < 1 || threshold > count)) {
      problems.push(`${path}.threshold: must be between 1 and ${count} for an any-join`);
    }
  }
}

function validateLoopContract(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  const maxIterations = raw['maxIterations'];
  if (
    typeof maxIterations !== 'number' ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > WORKFLOW_MAX_LOOP_ITERATIONS
  ) {
    problems.push(
      `${path}.maxIterations: the explicit iteration bound must be an integer between 1 and ${WORKFLOW_MAX_LOOP_ITERATIONS}`,
    );
  }
  const termination = raw['termination'];
  if (!isRecord(termination)) {
    problems.push(`${path}.termination: the termination contract is required`);
  } else {
    const kind = termination['kind'];
    if (kind !== 'count' && kind !== 'predicate') {
      problems.push(`${path}.termination.kind: must be count or predicate`);
    }
    const predicateRef = termination['predicateRef'];
    if (kind === 'predicate') {
      if (
        !isPlainString(predicateRef) ||
        predicateRef.trim() === '' ||
        predicateRef.length > REF_MAX_LENGTH
      ) {
        problems.push(
          `${path}.termination.predicateRef: predicate termination requires a non-empty predicate reference (max ${REF_MAX_LENGTH} chars)`,
        );
      }
    } else if (predicateRef !== undefined && predicateRef !== null) {
      problems.push(`${path}.termination.predicateRef: only predicate termination carries a predicate reference`);
    }
  }
}

function validateNodeRetryPolicy(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  const maxAttempts = raw['maxAttempts'];
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS
  ) {
    problems.push(`${path}.maxAttempts: must be an integer between 1 and ${MAX_ATTEMPTS}`);
  }
  const backoffMs = raw['backoffMs'];
  if (backoffMs !== undefined && backoffMs !== null) {
    if (typeof backoffMs !== 'number' || !Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > MAX_BACKOFF_MS) {
      problems.push(`${path}.backoffMs: must be an integer between 0 and ${MAX_BACKOFF_MS}`);
    }
  }
}

function validateNodeTimeout(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return;
  }
  const seconds = raw['seconds'];
  if (
    typeof seconds !== 'number' ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > MAX_TIMEOUT_SECONDS
  ) {
    problems.push(`${path}.seconds: must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`);
  }
}

// ---------------------------------------------------------------------------
// Schemas and definition-level policy blocks
// ---------------------------------------------------------------------------

function extractSchemaShape(raw: unknown): WorkflowSchemaShape | null {
  if (!isRecord(raw)) return null;
  const properties = raw['properties'];
  if (!isRecord(properties)) return null;
  const required = raw['required'];
  return {
    type: 'object',
    properties: properties as unknown as Record<string, WorkflowSchemaProperty>,
    required: Array.isArray(required) ? (required as unknown as string[]) : [],
  };
}

function validateSchemaShape(raw: unknown, path: string, problems: Problems): void {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object schema`);
    return;
  }
  if (raw['type'] !== 'object') {
    problems.push(`${path}.type: must be 'object'`);
  }
  const properties = raw['properties'];
  if (!isRecord(properties)) {
    problems.push(`${path}.properties: must be an object of property definitions`);
    return;
  }
  const keys = Object.keys(properties);
  if (keys.length > WORKFLOW_MAX_SCHEMA_PROPERTIES) {
    problems.push(`${path}.properties: at most ${WORKFLOW_MAX_SCHEMA_PROPERTIES} properties are allowed`);
  }
  keys.forEach((key) => {
    if (key.trim() === '' || key.length > 100) {
      problems.push(`${path}.properties: property names must be non-empty (max 100 chars)`);
    }
    const property = properties[key];
    if (!isRecord(property)) {
      problems.push(`${path}.properties.${key}: must be an object`);
      return;
    }
    if (!PROPERTY_TYPES.includes(property['type'] as string)) {
      problems.push(
        `${path}.properties.${key}.type: must be one of ${PROPERTY_TYPES.join(', ')}`,
      );
    }
    const description = property['description'];
    if (description !== undefined && description !== null && !isPlainString(description)) {
      problems.push(`${path}.properties.${key}.description: must be a string when present`);
    }
  });
  const required = raw['required'];
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      problems.push(`${path}.required: must be an array of property names`);
    } else {
      const seen = new Set<string>();
      required.forEach((name) => {
        if (!isPlainString(name)) {
          problems.push(`${path}.required: property names must be strings`);
        } else if (!(name in properties)) {
          problems.push(`${path}.required: ${name} is not a declared property`);
        } else if (seen.has(name)) {
          problems.push(`${path}.required: duplicate entry ${name}`);
        } else {
          seen.add(name);
        }
      });
    }
  }
}

function validateRetryPolicyDefaults(raw: unknown, problems: Problems): void {
  if (raw === undefined || raw === null) {
    problems.push('retryPolicyDefaults: must be an object (empty when no defaults are declared)');
    return;
  }
  if (!isRecord(raw)) {
    problems.push('retryPolicyDefaults: must be an object');
    return;
  }
  const maxAttempts = raw['maxAttempts'];
  if (maxAttempts !== undefined && maxAttempts !== null) {
    if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
      problems.push(`retryPolicyDefaults.maxAttempts: must be an integer between 1 and ${MAX_ATTEMPTS}`);
    }
  }
  const backoffMs = raw['backoffMs'];
  if (backoffMs !== undefined && backoffMs !== null) {
    if (typeof backoffMs !== 'number' || !Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > MAX_BACKOFF_MS) {
      problems.push(`retryPolicyDefaults.backoffMs: must be an integer between 0 and ${MAX_BACKOFF_MS}`);
    }
  }
}

function validateConcurrencyLimits(raw: unknown, problems: Problems): void {
  if (raw === undefined || raw === null) {
    problems.push('concurrencyLimits: must be an object (empty when no limits are declared)');
    return;
  }
  if (!isRecord(raw)) {
    problems.push('concurrencyLimits: must be an object');
    return;
  }
  for (const key of ['maxConcurrentWorkflows', 'maxConcurrentNodes'] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
        problems.push(`concurrencyLimits.${key}: must be an integer between 1 and ${MAX_CONCURRENCY}`);
      }
    }
  }
}

function validateTimeoutPolicy(raw: unknown, problems: Problems): void {
  if (raw === undefined || raw === null) {
    problems.push('timeoutPolicy: must be an object (empty when no timeouts are declared)');
    return;
  }
  if (!isRecord(raw)) {
    problems.push('timeoutPolicy: must be an object');
    return;
  }
  const defaultTimeoutSeconds = raw['defaultTimeoutSeconds'];
  const maxTimeoutSeconds = raw['maxTimeoutSeconds'];
  for (const [key, value] of [
    ['defaultTimeoutSeconds', defaultTimeoutSeconds],
    ['maxTimeoutSeconds', maxTimeoutSeconds],
  ] as const) {
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
        problems.push(`timeoutPolicy.${key}: must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`);
      }
    }
  }
  if (
    typeof defaultTimeoutSeconds === 'number' &&
    typeof maxTimeoutSeconds === 'number' &&
    maxTimeoutSeconds < defaultTimeoutSeconds
  ) {
    problems.push('timeoutPolicy: maxTimeoutSeconds cannot be below defaultTimeoutSeconds');
  }
}

function validateCompensation(
  raw: unknown,
  graph: WorkflowGraph | null,
  problems: Problems,
): void {
  if (raw === undefined || raw === null) {
    problems.push('compensation: must be an array (empty when nothing is compensated)');
    return;
  }
  if (!Array.isArray(raw)) {
    problems.push('compensation: must be an array of compensation declarations');
    return;
  }
  if (raw.length > WORKFLOW_MAX_COMPENSATION_ENTRIES) {
    problems.push(`compensation: at most ${WORKFLOW_MAX_COMPENSATION_ENTRIES} declarations are allowed`);
  }
  const nodesById = new Map<string, WorkflowNode>();
  if (graph !== null) {
    for (const node of graph.nodes) {
      if (isRecord(node) && isPlainString(node['nodeId'])) {
        nodesById.set(node['nodeId'], node as unknown as WorkflowNode);
      }
    }
  }
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const path = `compensation[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${path}: must be an object`);
      return;
    }
    const nodeId = entry['nodeId'];
    const compensateViaNodeId = entry['compensateViaNodeId'];
    if (!isPlainString(nodeId) || !ID_PATTERN.test(nodeId)) {
      problems.push(`${path}.nodeId: a non-empty node identifier is required`);
    } else if (nodesById.size > 0 && !nodesById.has(nodeId)) {
      problems.push(`${path}.nodeId: ${nodeId} is not a node of this graph`);
    } else if (nodesById.size > 0 && !EXECUTABLE_NODE_TYPES.includes(nodesById.get(nodeId)!['nodeType'] as WorkflowNodeType)) {
      problems.push(`${path}.nodeId: only executable nodes are compensable (${nodeId})`);
    } else if (seen.has(nodeId)) {
      problems.push(`${path}.nodeId: duplicate compensation for ${nodeId}`);
    } else {
      seen.add(nodeId);
    }
    if (!isPlainString(compensateViaNodeId) || !ID_PATTERN.test(compensateViaNodeId)) {
      problems.push(`${path}.compensateViaNodeId: a non-empty node identifier is required`);
    } else if (nodesById.size > 0 && !nodesById.has(compensateViaNodeId)) {
      problems.push(`${path}.compensateViaNodeId: ${compensateViaNodeId} is not a node of this graph`);
    } else if (nodesById.size > 0 && !EXECUTABLE_NODE_TYPES.includes(nodesById.get(compensateViaNodeId)!['nodeType'] as WorkflowNodeType)) {
      problems.push(`${path}.compensateViaNodeId: only executable nodes can compensate (${compensateViaNodeId})`);
    }
    if (nodeId === compensateViaNodeId) {
      problems.push(`${path}: a node cannot compensate itself`);
    }
  });
}

// ---------------------------------------------------------------------------
// Graph structure (edges, joins, loops, cycles, reachability, mappings)
// ---------------------------------------------------------------------------

interface NormalizedGraph {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly nodesById: Map<string, WorkflowNode>;
  readonly outgoing: Map<string, WorkflowEdge[]>;
  readonly incoming: Map<string, WorkflowEdge[]>;
  readonly reachable: Map<string, Set<string>>;
}

function normalizeGraph(graph: WorkflowGraph): NormalizedGraph | null {
  const nodesById = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (!isRecord(node) || !isPlainString(node['nodeId'])) return null;
    nodesById.set(node['nodeId'], node as unknown as WorkflowNode);
  }
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const node of graph.nodes) {
    const id = (node as unknown as Record<string, unknown>)['nodeId'] as string;
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const edge of graph.edges) {
    if (!isRecord(edge)) return null;
    const from = edge['fromNode'];
    const to = edge['toNode'];
    if (!isPlainString(from) || !isPlainString(to)) return null;
    const typedEdge = edge as unknown as WorkflowEdge;
    outgoing.get(from)?.push(typedEdge);
    incoming.get(to)?.push(typedEdge);
  }
  // Forward reachability per node (n ≤ 200, e ≤ 500 — cheap).
  const reachable = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const id = (node as unknown as Record<string, unknown>)['nodeId'] as string;
    const visited = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of outgoing.get(current) ?? []) {
        if (!visited.has(edge.toNode)) queue.push(edge.toNode);
      }
    }
    reachable.set(id, visited);
  }
  return { nodes: graph.nodes, edges: graph.edges, nodesById, outgoing, incoming, reachable };
}

/**
 * The structural pass — runs only when the graph object was shape-valid
 * (extractGraph succeeded). Enforces the frozen §4 MUST list over the
 * RESOLVED graph: dangling edges, duplicate node IDs, edge legality per
 * node class, join contracts, bounded loops, illegal cycles, reachability
 * and resolved schema mappings.
 */
function validateGraphStructure(
  graph: WorkflowGraph,
  inputSchema: WorkflowSchemaShape | null,
  problems: Problems,
): void {
  const normalized = normalizeGraph(graph);
  if (normalized === null) return;
  const { nodes, edges, nodesById, outgoing, incoming, reachable } = normalized;

  // --- duplicate node IDs ---
  const seenNodeIds = new Set<string>();
  nodes.forEach((rawNode, index) => {
    const node = rawNode as unknown as Record<string, unknown>;
    const nodeId = node['nodeId'];
    if (!isPlainString(nodeId)) return;
    if (seenNodeIds.has(nodeId)) {
      problems.push(`graph.nodes[${index}]: duplicate node id ${nodeId}`);
    } else {
      seenNodeIds.add(nodeId);
    }
  });

  // --- dangling edges + duplicate ordered pairs + self-edges ---
  const pairsSeen = new Set<string>();
  edges.forEach((rawEdge, index) => {
    const edge = rawEdge as unknown as Record<string, unknown>;
    const from = edge['fromNode'];
    const to = edge['toNode'];
    if (!isPlainString(from) || !isPlainString(to)) return;
    const path = `graph.edges[${index}]`;
    if (!nodesById.has(from)) {
      problems.push(`${path}: fromNode ${from} does not exist (dangling edge)`);
    }
    if (!nodesById.has(to)) {
      problems.push(`${path}: toNode ${to} does not exist (dangling edge)`);
    }
    if (from === to) {
      const nodeType = (nodesById.get(from) as unknown as Record<string, unknown> | undefined)?.['nodeType'];
      if (nodeType !== 'loop') {
        problems.push(`${path}: self-edges are iteration returns and only loop nodes may self-iterate`);
      }
    }
    const pairKey = `${from}\u0000${to}`;
    if (pairsSeen.has(pairKey)) {
      problems.push(`${path}: at most one edge may connect ${from} → ${to}`);
    } else {
      pairsSeen.add(pairKey);
    }
  });

  // --- per-node-class edge legality ---
  for (const rawNode of nodes) {
    const node = rawNode as unknown as Record<string, unknown>;
    const nodeId = node['nodeId'];
    if (!isPlainString(nodeId)) continue;
    const nodeType = node['nodeType'];
    const out = outgoing.get(nodeId) ?? [];
    const inEdges = incoming.get(nodeId) ?? [];
    const structural = STRUCTURAL_NODE_TYPES.includes(nodeType as WorkflowNodeType);

    if (nodeType === 'terminal') {
      if (out.length > 0) {
        problems.push(
          `node ${nodeId}: terminal/outcome recorder nodes have no outgoing edges (${out.length} found)`,
        );
      }
    } else if (out.length === 0) {
      problems.push(`node ${nodeId}: every non-terminal node needs at least one outgoing edge (dead end)`);
    }

    if (nodeType === 'condition') {
      const nonConditional = out.filter((edge) => (edge as unknown as Record<string, unknown>)['edgeType'] !== 'conditional');
      if (nonConditional.length > 0) {
        problems.push(
          `node ${nodeId}: conditional branches express every outgoing edge as conditional (${nonConditional.length} found)`,
        );
      }
      if (out.length < 2) {
        problems.push(`node ${nodeId}: a conditional branch needs at least two outgoing branches`);
      }
    }

    for (const rawEdge of out) {
      const edge = rawEdge as unknown as Record<string, unknown>;
      const edgeType = edge['edgeType'];
      if (edgeType === 'failure' && structural) {
        problems.push(
          `node ${nodeId}: structural control nodes (${nodeType}) cannot fail and carry no failure edges`,
        );
      }
      if (edgeType === 'join') {
        const target = edge['toNode'];
        const targetType = isPlainString(target)
          ? (nodesById.get(target) as unknown as Record<string, unknown> | undefined)?.['nodeType']
          : undefined;
        if (targetType !== 'join') {
          problems.push(
            `node ${nodeId}: join-type edges converge only into join nodes (target ${String(target)} is ${String(targetType)})`,
          );
        }
      }
    }

    // Edges INTO a join node must all be join-type edges.
    if (nodeType === 'join') {
      for (const rawEdge of inEdges) {
        const edge = rawEdge as unknown as Record<string, unknown>;
        if (edge['edgeType'] !== 'join') {
          problems.push(
            `node ${nodeId}: every edge into a join node must be a join-type edge (${String(edge['edgeType'])} from ${String(edge['fromNode'])} found)`,
          );
        }
      }
    }

    // Implicit-join rule: convergence with downstream flow requires an
    // explicit join contract. Terminals are EXEMPT — the outcome recorder
    // is a SINK: every arrival records its outcome ("workflow-level
    // success/failure is derived from terminal node outcomes", §5) and no
    // downstream node depends on a release decision, so multiple incoming
    // paths (e.g. a rejection branch and a success branch reaching the
    // same recorder) carry no convergence semantics.
    if (nodeType !== 'join' && nodeType !== 'loop' && nodeType !== 'terminal' && inEdges.length > 1) {
      problems.push(
        `node ${nodeId}: ${inEdges.length} edges converge without a join contract (only join nodes converge branches; loop nodes return to themselves)`,
      );
    }
  }

  // --- join contracts against the resolved convergence ---
  for (const rawNode of nodes) {
    const node = rawNode as unknown as Record<string, unknown>;
    if (node['nodeType'] !== 'join') continue;
    const nodeId = node['nodeId'] as string;
    const join = node['join'] as unknown as Record<string, unknown> | null | undefined;
    const inEdges = (incoming.get(nodeId) ?? []) as unknown as Record<string, unknown>[];
    const joinEdgeSources = new Set(
      inEdges.filter((edge) => edge['edgeType'] === 'join').map((edge) => edge['fromNode'] as string),
    );
    if (!isRecord(join)) continue;
    const declared = join['predecessors'];
    const declaredSet = new Set<string>(Array.isArray(declared) ? (declared as string[]) : []);
    const semantics = join['semantics'];

    for (const source of joinEdgeSources) {
      if (!declaredSet.has(source)) {
        problems.push(
          `node ${nodeId}: join edge from ${source} is not a declared predecessor of the join contract`,
        );
      }
      const edge = inEdges.find(
        (candidate) => candidate['fromNode'] === source && candidate['edgeType'] === 'join',
      );
      if (edge !== undefined && edge['joinSemantics'] !== semantics) {
        problems.push(
          `node ${nodeId}: the join edge from ${source} must mirror the declared ${String(semantics)} semantics`,
        );
      }
    }
    for (const predecessor of declaredSet) {
      if (!joinEdgeSources.has(predecessor)) {
        problems.push(
          `node ${nodeId}: declared predecessor ${predecessor} has no join edge into this node (impossible join)`,
        );
      }
    }
  }

  // --- cycles: every cycle must pass through a loop node with a bounded
  // contract. Formalized: the graph with ALL loop nodes removed must be
  // acyclic (any cycle avoiding every loop node survives the removal). ---
  const loopNodes = new Set<string>();
  for (const rawNode of nodes) {
    const node = rawNode as unknown as Record<string, unknown>;
    if (node['nodeType'] === 'loop') loopNodes.add(node['nodeId'] as string);
  }
  const residualEdges: Array<{ from: string; to: string }> = [];
  for (const rawEdge of edges) {
    const edge = rawEdge as unknown as Record<string, unknown>;
    const from = edge['fromNode'];
    const to = edge['toNode'];
    if (!isPlainString(from) || !isPlainString(to)) continue;
    if (loopNodes.has(from) || loopNodes.has(to)) continue;
    residualEdges.push({ from, to });
  }
  const cycle = findCycle(residualEdges);
  if (cycle !== null) {
    problems.push(
      `graph: illegal cycle ${cycle.join(' → ')} → ${cycle[0]} — cycles are legal only inside an explicit bounded loop construct (a loop node with an iteration/termination contract)`,
    );
  }

  // --- loop-node entries: at most ONE edge from OUTSIDE the loop's own
  // cyclic region (every other incoming edge is an iteration return). ---
  for (const loopNodeId of loopNodes) {
    // The loop's cyclic region: nodes that reach the loop AND are reachable
    // from it (its strongly connected component, conservatively).
    const reachesLoop = new Set<string>();
    for (const [nodeId, visited] of reachable) {
      if (visited.has(loopNodeId)) reachesLoop.add(nodeId);
    }
    const region = new Set<string>();
    for (const nodeId of reachesLoop) {
      if ((reachable.get(loopNodeId) ?? new Set<string>()).has(nodeId)) region.add(nodeId);
    }
    let externalEntries = 0;
    for (const rawEdge of incoming.get(loopNodeId) ?? []) {
      const edge = rawEdge as unknown as Record<string, unknown>;
      const from = edge['fromNode'] as string;
      if (!region.has(from)) externalEntries += 1;
    }
    if (externalEntries > 1) {
      problems.push(
        `node ${loopNodeId}: a loop construct has a single entry (${externalEntries} external incoming edges found — converging entries need a join)`,
      );
    }
    if ((incoming.get(loopNodeId) ?? []).length === 0) {
      problems.push(`node ${loopNodeId}: a loop construct must be reachable (no incoming edge)`);
    }
  }

  // --- entry, terminals and reachability ---
  // ONE deterministic start: exactly one entry node (no incoming edges)
  // exists and every node is reachable from it. This is the strict
  // "dangling nodes" rejection — a disconnected component either brings
  // its own entry (rejected here: exactly one entry) or is a pure cycle
  // with no entry at all (rejected as unreachable). Parallel starts are
  // expressed as fan-out from the single entry, where they are explicit,
  // visible and join-able.
  const entryNodes = nodes.filter(
    (rawNode) => (incoming.get((rawNode as unknown as Record<string, unknown>)['nodeId'] as string) ?? []).length === 0,
  );
  if (entryNodes.length === 0) {
    problems.push('graph: an entry node (no incoming edges) is required — a pure cycle cannot start');
  }
  if (entryNodes.length > 1) {
    problems.push(
      `graph: exactly one entry node is required (found ${entryNodes.length}: ${entryNodes
        .map((rawNode) => (rawNode as unknown as Record<string, unknown>)['nodeId'])
        .join(', ')}) — parallel starts are fan-out from the single entry`,
    );
  }
  const terminalNodes = nodes.filter(
    (rawNode) => (rawNode as unknown as Record<string, unknown>)['nodeType'] === 'terminal',
  );
  if (terminalNodes.length === 0) {
    problems.push('graph: at least one terminal/outcome recorder node is required');
  }
  const reachableFromEntries = new Set<string>();
  for (const rawNode of entryNodes) {
    const nodeId = (rawNode as unknown as Record<string, unknown>)['nodeId'] as string;
    for (const visited of reachable.get(nodeId) ?? []) reachableFromEntries.add(visited);
  }
  for (const rawNode of nodes) {
    const node = rawNode as unknown as Record<string, unknown>;
    const nodeId = node['nodeId'];
    if (!isPlainString(nodeId)) continue;
    if (!reachableFromEntries.has(nodeId)) {
      problems.push(`node ${nodeId}: not reachable from the entry node (dangling node)`);
    }
  }

  // --- schema mapping resolution ---
  const inputProperties = new Set<string>(
    inputSchema !== null ? Object.keys(inputSchema.properties) : [],
  );
  for (const rawNode of nodes) {
    const node = rawNode as unknown as Record<string, unknown>;
    const nodeId = node['nodeId'];
    if (!isPlainString(nodeId)) continue;
    const mapping = node['inputMapping'];
    if (!isRecord(mapping)) continue;
    for (const [field, rawSource] of Object.entries(mapping)) {
      const source = rawSource as unknown as Record<string, unknown>;
      if (!isRecord(source)) continue;
      const path = source['path'];
      if (!isPlainString(path)) continue;
      const firstSegment = path.split('.')[0]!;
      if (source['source'] === 'workflow_input') {
        if (inputProperties.size === 0 || !inputProperties.has(firstSegment)) {
          problems.push(
            `node ${nodeId}.inputMapping.${field}: workflow input property '${firstSegment}' is not declared in the definition input schema (unresolved schema mapping)`,
          );
        }
      } else if (source['source'] === 'node_output') {
        const sourceNodeId = source['nodeId'];
        if (!isPlainString(sourceNodeId)) continue;
        const sourceNode = nodesById.get(sourceNodeId) as unknown as Record<string, unknown> | undefined;
        if (sourceNode === undefined) {
          problems.push(
            `node ${nodeId}.inputMapping.${field}: source node ${sourceNodeId} does not exist (unresolved schema mapping)`,
          );
          continue;
        }
        if (!(reachable.get(sourceNodeId) ?? new Set<string>()).has(nodeId)) {
          problems.push(
            `node ${nodeId}.inputMapping.${field}: source node ${sourceNodeId} is not an upstream predecessor of ${nodeId} (unresolved schema mapping)`,
          );
          continue;
        }
        const outputSchema = sourceNode['outputSchema'] as unknown as Record<string, unknown> | undefined;
        const properties = isRecord(outputSchema) ? outputSchema['properties'] : undefined;
        const declared = isRecord(properties) ? Object.keys(properties) : [];
        if (!declared.includes(firstSegment)) {
          problems.push(
            `node ${nodeId}.inputMapping.${field}: node ${sourceNodeId} does not declare output property '${firstSegment}' (unresolved schema mapping)`,
          );
        }
      }
    }
  }
}

/** DFS cycle detection over a plain edge list; returns one cycle if present. */
function findCycle(edges: ReadonlyArray<{ from: string; to: string }>): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  for (const node of adjacency.keys()) color.set(node, WHITE);

  for (const start of adjacency.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack: Array<{ node: string; iter: number }> = [{ node: start, iter: 0 }];
    parent.set(start, null);
    color.set(start, GRAY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const neighbors = adjacency.get(top.node) ?? [];
      if (top.iter < neighbors.length) {
        const next = neighbors[top.iter]!;
        top.iter += 1;
        if (color.get(next) === GRAY) {
          // Reconstruct the cycle from `next` up to the current node.
          const cycle: string[] = [next];
          let cursor: string | null = top.node;
          while (cursor !== null && cursor !== next) {
            cycle.push(cursor);
            cursor = parent.get(cursor) ?? null;
          }
          cycle.push(next);
          return cycle.reverse();
        }
        if (color.get(next) === WHITE) {
          color.set(next, GRAY);
          parent.set(next, top.node);
          stack.push({ node: next, iter: 0 });
        }
      } else {
        color.set(top.node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}
