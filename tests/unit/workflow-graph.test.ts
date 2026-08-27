/**
 * MKT-008 unit tests — the typed Workflow Graph authority (pure, no DB).
 *
 * Proofs (WF-001 "Implement one deterministic Workflow Graph authority
 * with typed node/edge contracts"; implementation-contract §4 "Workflow
 * validation MUST reject dangling nodes/edges, invalid node types,
 * impossible joins, duplicate node IDs, illegal cycles, and unresolved
 * schema mappings. Cycles are allowed only where an explicit bounded loop
 * construct declares its iteration/termination contract."; architecture.md
 * §10 node class list):
 *   - legal graphs pass exhaustively-validated content (minimal linear,
 *     and a rich graph exercising EVERY frozen node class, join semantics,
 *     bounded loops, predicates and resolved schema mappings);
 *   - every frozen MUST-list rejection fires with a precise problem:
 *     dangling nodes/edges, invalid node types, impossible joins,
 *     duplicate node IDs, illegal cycles, unresolved schema mappings;
 *   - typed node contracts: per-class required/forbidden fields (human
 *     approval on human-class nodes only, retry/timeout/idempotency/
 *     execution-policy on executable nodes only, join/loop contracts on
 *     their own classes, control nodes consume no inputs);
 *   - edge legality: the frozen edge types, predicate rules, join-edge
 *     targeting/mirroring, terminal/failure/condition rules, one edge per
 *     ordered pair, self-iteration only on loop nodes;
 *   - bounded loops: explicit iteration/termination contracts, the hard
 *     iteration bound, and the cycle rule (every cycle passes through a
 *     loop node — a cycle avoiding every loop node is illegal, a loop's
 *     returns come from inside its own cyclic region, single entry);
 *   - schema mapping resolution against declared schema properties and
 *     upstream (ancestor) node outputs;
 *   - definition-level policy blocks (retry defaults, concurrency limits,
 *     timeout policy, compensation declarations referencing executable
 *     nodes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowDefinitionContent } from '../../src/modules/workflows/public.ts';

// ---------------------------------------------------------------------------
// Builders (every builder produces a VALID object; tests mutate one aspect)
// ---------------------------------------------------------------------------

interface LooseNode {
  nodeId: string;
  nodeType: string;
  inputMapping?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  executionPolicyRef?: string | null;
  retryPolicy?: Record<string, unknown> | null;
  timeout?: Record<string, unknown> | null;
  idempotencyKeyStrategy?: string | null;
  humanApproval?: Record<string, unknown> | null;
  join?: Record<string, unknown> | null;
  loop?: Record<string, unknown> | null;
}

interface LooseEdge {
  fromNode: string;
  toNode: string;
  edgeType: string;
  predicateRef?: string | null;
  joinSemantics?: string | null;
}

const emptySchema = { type: 'object', properties: {}, required: [] };

function functionNode(nodeId: string, overrides: Partial<LooseNode> = {}): LooseNode {
  return {
    nodeId,
    nodeType: 'function',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string' } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
    ...overrides,
  };
}

function terminalNode(nodeId: string, overrides: Partial<LooseNode> = {}): LooseNode {
  return functionNode(nodeId, {
    nodeType: 'terminal',
    outputSchema: { type: 'object', properties: { outcome: { type: 'string' } }, required: [] },
    ...overrides,
  });
}

function successEdge(fromNode: string, toNode: string): LooseEdge {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

function conditionalEdge(fromNode: string, toNode: string, predicateRef: string): LooseEdge {
  return { fromNode, toNode, edgeType: 'conditional', predicateRef, joinSemantics: null };
}

function joinEdge(fromNode: string, toNode: string, semantics: 'all' | 'any'): LooseEdge {
  return { fromNode, toNode, edgeType: 'join', predicateRef: null, joinSemantics: semantics };
}

function minimalContent(): Record<string, unknown> {
  return {
    graph: {
      nodes: [functionNode('a'), terminalNode('t')],
      edges: [successEdge('a', 't')],
    },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    retryPolicyDefaults: {},
    concurrencyLimits: {},
    timeoutPolicy: {},
    compensation: [],
  };
}

/**
 * A rich VALID graph exercising every frozen node class except the ones
 * covered by minimalContent: approval (human approval requirement),
 * condition (predicate branches), loop (bounded iteration with back
 * edge), api_action, join (all-semantics convergence), terminal outcome
 * recorder — plus workflow-input and node-output schema mappings.
 */
function richContent(): Record<string, unknown> {
  const nodes: LooseNode[] = [
    functionNode('generate', {
      inputMapping: { campaignName: { source: 'workflow_input', path: 'campaignName' } },
      retryPolicy: { maxAttempts: 3, backoffMs: 1000 },
      timeout: { seconds: 300 },
      idempotencyKeyStrategy: 'node',
    }),
    functionNode('approve', {
      nodeType: 'approval',
      inputMapping: { copy: { source: 'node_output', nodeId: 'generate', path: 'out' } },
      outputSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: [] },
      humanApproval: { required: true, approverPolicyRef: 'policy/approvers' },
    }),
    functionNode('gate', {
      nodeType: 'condition',
      outputSchema: { type: 'object', properties: { branch: { type: 'string' } }, required: [] },
    }),
    functionNode('refine', {
      outputSchema: { type: 'object', properties: { copy: { type: 'string' } }, required: [] },
    }),
    functionNode('polish', {
      nodeType: 'loop',
      loop: {
        maxIterations: 3,
        termination: { kind: 'predicate', predicateRef: 'policy/copy-good' },
      },
      outputSchema: { type: 'object', properties: { iterations: { type: 'number' } }, required: [] },
    }),
    functionNode('publish', {
      nodeType: 'api_action',
      outputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [] },
      executionPolicyRef: 'policy/publish-rate',
    }),
    functionNode('merge', {
      nodeType: 'join',
      join: { semantics: 'all', predecessors: ['polish', 'publish'], threshold: null },
      outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: [] },
    }),
    terminalNode('record', {
      inputMapping: { url: { source: 'node_output', nodeId: 'publish', path: 'url' } },
    }),
  ];
  const edges: LooseEdge[] = [
    successEdge('generate', 'approve'),
    successEdge('approve', 'gate'),
    conditionalEdge('gate', 'polish', 'policy/approved'),
    conditionalEdge('gate', 'record', 'policy/rejected'),
    successEdge('polish', 'refine'),
    successEdge('refine', 'polish'),
    conditionalEdge('polish', 'publish', 'policy/copy-good'),
    joinEdge('polish', 'merge', 'all'),
    joinEdge('publish', 'merge', 'all'),
    successEdge('merge', 'record'),
  ];
  return {
    graph: { nodes, edges },
    inputSchema: {
      type: 'object',
      properties: {
        campaignName: { type: 'string' },
        budget: { type: 'number' },
      },
      required: ['campaignName'],
    },
    outputSchema: {
      type: 'object',
      properties: { outcome: { type: 'string' } },
      required: ['outcome'],
    },
    retryPolicyDefaults: { maxAttempts: 2, backoffMs: 500 },
    concurrencyLimits: { maxConcurrentWorkflows: 5, maxConcurrentNodes: 10 },
    timeoutPolicy: { defaultTimeoutSeconds: 600, maxTimeoutSeconds: 3600 },
    compensation: [{ nodeId: 'publish', compensateViaNodeId: 'generate' }],
  };
}

function problemsOf(content: unknown): string[] {
  return [...validateWorkflowDefinitionContent(content)];
}

function nodesOf(content: Record<string, unknown>): LooseNode[] {
  return (content['graph'] as { nodes: LooseNode[] }).nodes;
}

function edgesOf(content: Record<string, unknown>): LooseEdge[] {
  return (content['graph'] as { edges: LooseEdge[] }).edges;
}

// ---------------------------------------------------------------------------
// Legal graphs
// ---------------------------------------------------------------------------

test('a minimal linear graph (function → terminal) validates cleanly', () => {
  assert.deepEqual(problemsOf(minimalContent()), []);
});

test('a rich graph with every frozen control construct validates cleanly', () => {
  const problems = problemsOf(richContent());
  assert.deepEqual(problems, []);
});

test('a loop node may self-iterate (the degenerate bounded loop)', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('spin', {
      nodeType: 'loop',
      loop: { maxIterations: 5, termination: { kind: 'count', predicateRef: null } },
    }),
  );
  edgesOf(content).push(successEdge('a', 'spin'));
  edgesOf(content).push(successEdge('spin', 'spin'));
  edgesOf(content).push(successEdge('spin', 't'));
  assert.deepEqual(problemsOf(content), []);
});

test('an any-join with an explicit threshold validates cleanly', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('b1'),
    functionNode('b2'),
    functionNode('b3'),
    functionNode('fan', {
      nodeType: 'join',
      join: { semantics: 'any', predecessors: ['b1', 'b2', 'b3'], threshold: 2 },
    }),
  );
  edgesOf(content).push(successEdge('a', 'b1'));
  edgesOf(content).push(successEdge('a', 'b2'));
  edgesOf(content).push(successEdge('a', 'b3'));
  edgesOf(content).push(joinEdge('b1', 'fan', 'any'));
  edgesOf(content).push(joinEdge('b2', 'fan', 'any'));
  edgesOf(content).push(joinEdge('b3', 'fan', 'any'));
  edgesOf(content).push(successEdge('fan', 't'));
  assert.deepEqual(problemsOf(content), []);
});

// ---------------------------------------------------------------------------
// Shape rejections (the frozen §4 MUST list)
// ---------------------------------------------------------------------------

test('non-object content is rejected', () => {
  assert.equal(problemsOf('nonsense').length, 1);
  assert.ok(problemsOf('nonsense')[0]!.includes('must be an object'));
});

test('an empty node list is rejected (at least one node)', () => {
  const content = minimalContent();
  (content['graph'] as { nodes: unknown[] }).nodes = [];
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('at least one node')));
});

test('duplicate node IDs are rejected', () => {
  const content = minimalContent();
  nodesOf(content).push(functionNode('a'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('duplicate node id a')));
});

test('invalid node types are rejected (outside the frozen class list)', () => {
  const content = minimalContent();
  nodesOf(content)[0]!.nodeType = 'robot_overlord';
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('frozen node classes')));
});

test('dangling edges are rejected (unknown fromNode and toNode)', () => {
  const content = minimalContent();
  edgesOf(content).push({ fromNode: 'ghost', toNode: 't', edgeType: 'success' });
  edgesOf(content).push({ fromNode: 'a', toNode: 'phantom', edgeType: 'success' });
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('fromNode ghost does not exist')));
  assert.ok(problems.some((p) => p.includes('toNode phantom does not exist')));
});

test('dangling (disconnected) nodes are rejected — exactly one entry exists', () => {
  const content = minimalContent();
  nodesOf(content).push(functionNode('island'));
  edgesOf(content).push(successEdge('island', 't'));
  // island brings its own entry (no incoming edge): a second entry is a
  // disconnected start, not a parallel start.
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('exactly one entry node is required')));
});

test('a second edge between the same ordered pair is rejected', () => {
  const content = minimalContent();
  edgesOf(content).push(successEdge('a', 't'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('at most one edge may connect a → t')));
});

test('self-edges are iteration returns and only loop nodes may self-iterate', () => {
  const content = minimalContent();
  edgesOf(content).push(successEdge('a', 'a'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('only loop nodes may self-iterate')));
});

test('a graph with no entry node is rejected', () => {
  const content = minimalContent();
  // a ⇄ t: every node has an incoming edge, so nothing can start the
  // graph (and the a → t → a cycle is illegal — no loop node).
  edgesOf(content).push(successEdge('t', 'a'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('an entry node (no incoming edges) is required')));
  assert.ok(problems.some((p) => p.includes('illegal cycle')));
});

test('a graph with no terminal node is rejected', () => {
  const content = minimalContent();
  nodesOf(content)[1] = functionNode('t2');
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('terminal/outcome recorder node is required')));
});

test('a non-terminal dead end is rejected', () => {
  const content = minimalContent();
  nodesOf(content).push(functionNode('deadend'));
  edgesOf(content).push(successEdge('a', 'deadend'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('needs at least one outgoing edge')));
});

// ---------------------------------------------------------------------------
// Typed node contracts
// ---------------------------------------------------------------------------

test('human_task and approval nodes REQUIRE a human approval requirement', () => {
  for (const nodeType of ['human_task', 'approval']) {
    const content = richContent();
    const approve = nodesOf(content).find((node) => node.nodeId === 'approve')!;
    approve.nodeType = nodeType;
    approve.humanApproval = null;
    const problems = problemsOf(content);
    assert.ok(
      problems.some((p) => p.includes('human_task and approval nodes must declare')),
      `${nodeType} must require human approval`,
    );
  }
});

test('non-human nodes must NOT carry a human approval requirement', () => {
  const content = richContent();
  const generate = nodesOf(content).find((node) => node.nodeId === 'generate')!;
  generate.humanApproval = { required: true, approverPolicyRef: null };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('only human_task and approval nodes')));
});

test('structural control nodes never carry retry policies, timeouts, idempotency or execution policies', () => {
  const content = richContent();
  const gate = nodesOf(content).find((node) => node.nodeId === 'gate')!;
  gate.retryPolicy = { maxAttempts: 2, backoffMs: null };
  gate.timeout = { seconds: 60 };
  gate.idempotencyKeyStrategy = 'node';
  gate.executionPolicyRef = 'policy/x';
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('never retry')));
  assert.ok(problems.some((p) => p.includes('never time out')));
  assert.ok(problems.some((p) => p.includes('no idempotency key')));
  assert.ok(problems.some((p) => p.includes('no execution policy')));
});

test('control nodes (condition/join/loop) consume no inputs', () => {
  const content = richContent();
  const polish = nodesOf(content).find((node) => node.nodeId === 'polish')!;
  polish.inputMapping = { x: { source: 'workflow_input', path: 'campaignName' } };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('consume no inputs')));
});

test('every node requires an object output schema', () => {
  const content = minimalContent();
  nodesOf(content)[0]!.outputSchema = { type: 'array' };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('outputSchema')));
  assert.ok(problems.some((p) => p.includes("type: must be 'object'")));
});

test('loop contracts belong to loop nodes only; join contracts to join nodes only', () => {
  const loopOnly = richContent();
  const generate = nodesOf(loopOnly).find((node) => node.nodeId === 'generate')!;
  generate.loop = { maxIterations: 2, termination: { kind: 'count', predicateRef: null } };
  assert.ok(problemsOf(loopOnly).some((p) => p.includes('only loop nodes carry')));

  const joinOnly = richContent();
  const refine = nodesOf(joinOnly).find((node) => node.nodeId === 'refine')!;
  refine.join = { semantics: 'all', predecessors: ['a', 'b'], threshold: null };
  assert.ok(problemsOf(joinOnly).some((p) => p.includes('only join nodes carry')));
});

// ---------------------------------------------------------------------------
// Edge legality
// ---------------------------------------------------------------------------

test('conditional edges REQUIRE predicate references; other edges must not carry one', () => {
  const noPredicate = richContent();
  const gateEdges = edgesOf(noPredicate).filter((edge) => edge.fromNode === 'gate');
  gateEdges[0]!.predicateRef = null;
  assert.ok(problemsOf(noPredicate).some((p) => p.includes('conditional edges must carry')));

  const strayPredicate = richContent();
  const generateEdge = edgesOf(strayPredicate).find((edge) => edge.fromNode === 'generate')!;
  generateEdge.predicateRef = 'policy/should-not-be-here';
  assert.ok(problemsOf(strayPredicate).some((p) => p.includes('only conditional edges carry')));
});

test('terminal nodes have no outgoing edges', () => {
  const content = richContent();
  edgesOf(content).push(successEdge('record', 'generate'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('terminal/outcome recorder nodes have no outgoing')));
});

test('condition nodes express every outgoing edge as conditional and need at least two branches', () => {
  const nonConditional = richContent();
  const gateEdge = edgesOf(nonConditional).find((edge) => edge.fromNode === 'gate')!;
  gateEdge.edgeType = 'success';
  gateEdge.predicateRef = null;
  assert.ok(problemsOf(nonConditional).some((p) => p.includes('express every outgoing edge as conditional')));

  const singleBranch = richContent();
  edgesOf(singleBranch).splice(
    edgesOf(singleBranch).findIndex((edge) => edge.fromNode === 'gate' && edge.toNode === 'record'),
    1,
  );
  assert.ok(problemsOf(singleBranch).some((p) => p.includes('at least two outgoing branches')));
});

test('failure edges originate only at executable nodes', () => {
  const content = richContent();
  const gateEdge = edgesOf(content).find((edge) => edge.fromNode === 'gate')!;
  gateEdge.edgeType = 'failure';
  gateEdge.predicateRef = null;
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('cannot fail and carry no failure edges')));
});

test('join-type edges converge only into join nodes', () => {
  const content = richContent();
  const publishEdge = edgesOf(content).find((edge) => edge.fromNode === 'publish')!;
  publishEdge.edgeType = 'join';
  publishEdge.joinSemantics = 'all';
  // publish → merge is a join edge into a join node (legal); redirect it to
  // the terminal instead: join edge into a non-join node.
  publishEdge.toNode = 'record';
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('join-type edges converge only into join nodes')));
});

test('every edge into a join node must be a join-type edge', () => {
  const content = richContent();
  const publishEdge = edgesOf(content).find((edge) => edge.fromNode === 'publish')!;
  publishEdge.edgeType = 'success';
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('every edge into a join node must be a join-type edge')));
});

test('terminal outcome recorders are sinks — multiple incoming paths carry no convergence semantics', () => {
  const content = minimalContent();
  nodesOf(content).push(functionNode('b'));
  edgesOf(content).push(successEdge('a', 'b'));
  edgesOf(content).push(successEdge('b', 't'));
  // t receives from a AND b: legal for a terminal (every arrival records
  // its outcome; no downstream release decision exists).
  assert.deepEqual(problemsOf(content), []);
});

test('convergence without a join contract is rejected (implicit join)', () => {
  const content = minimalContent();
  nodesOf(content).push(functionNode('b1'), functionNode('b2'), functionNode('mid'));
  edgesOf(content).push(successEdge('a', 'b1'));
  edgesOf(content).push(successEdge('a', 'b2'));
  edgesOf(content).push(successEdge('b1', 'mid'));
  edgesOf(content).push(successEdge('b2', 'mid')); // mid: 2 incoming, not a join
  edgesOf(content).push(successEdge('mid', 't'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('converge without a join contract')));
});

// ---------------------------------------------------------------------------
// Join semantics and impossible joins
// ---------------------------------------------------------------------------

test('a join converges at least two branches', () => {
  const content = richContent();
  const merge = nodesOf(content).find((node) => node.nodeId === 'merge')!;
  (merge.join as { predecessors: string[] }).predecessors = ['polish'];
  // publish → merge edge is now from an undeclared node as well; both
  // problems are reported. The single-predecessor problem must fire.
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('converges at least two branches')));
});

test('a declared predecessor without a join edge is an impossible join', () => {
  const content = richContent();
  const merge = nodesOf(content).find((node) => node.nodeId === 'merge')!;
  (merge.join as { predecessors: string[] }).predecessors = ['polish', 'publish', 'refine'];
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('declared predecessor refine has no join edge')));
});

test('a join edge from an undeclared node is rejected', () => {
  const content = richContent();
  const merge = nodesOf(content).find((node) => node.nodeId === 'merge')!;
  (merge.join as { predecessors: string[] }).predecessors = ['polish', 'refine'];
  // publish → merge join edge now comes from an undeclared node.
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('not a declared predecessor')));
});

test('a join edge must mirror the declared join semantics', () => {
  const content = richContent();
  const merge = nodesOf(content).find((node) => node.nodeId === 'merge')!;
  (merge.join as { semantics: string }).semantics = 'any';
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('must mirror the declared any semantics')));
});

test('any-join thresholds must be satisfiable; all-join thresholds must equal the predecessor count', () => {
  const anyTooBig = minimalContent();
  nodesOf(anyTooBig).push(
    functionNode('b1'),
    functionNode('b2'),
    functionNode('fan', {
      nodeType: 'join',
      join: { semantics: 'any', predecessors: ['b1', 'b2'], threshold: 3 },
    }),
  );
  edgesOf(anyTooBig).push(successEdge('a', 'b1'));
  edgesOf(anyTooBig).push(successEdge('a', 'b2'));
  edgesOf(anyTooBig).push(joinEdge('b1', 'fan', 'any'));
  edgesOf(anyTooBig).push(joinEdge('b2', 'fan', 'any'));
  edgesOf(anyTooBig).push(successEdge('fan', 't'));
  assert.ok(problemsOf(anyTooBig).some((p) => p.includes('between 1 and 2 for an any-join')));

  const allMismatch = richContent();
  const merge = nodesOf(allMismatch).find((node) => node.nodeId === 'merge')!;
  (merge.join as { threshold: number }).threshold = 1;
  assert.ok(problemsOf(allMismatch).some((p) => p.includes('threshold must equal 2')));
});

test('a join whose predecessor is unreachable can never release (impossible join via reachability)', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('b1'),
    functionNode('island'),
    functionNode('fan', {
      nodeType: 'join',
      join: { semantics: 'all', predecessors: ['b1', 'island'], threshold: null },
    }),
  );
  edgesOf(content).push(successEdge('a', 'b1'));
  edgesOf(content).push(successEdge('island', 'fan')); // island's only path is its own second entry
  edgesOf(content).push(joinEdge('b1', 'fan', 'all'));
  edgesOf(content).push(joinEdge('island', 'fan', 'all'));
  edgesOf(content).push(successEdge('fan', 't'));
  const problems = problemsOf(content);
  // The island is a disconnected second entry — the join over it is
  // unreachable from the one real entry, so it can never release.
  assert.ok(problems.some((p) => p.includes('exactly one entry node is required')));
});

// ---------------------------------------------------------------------------
// Explicit bounded loops and illegal cycles
// ---------------------------------------------------------------------------

test('loop nodes must declare their explicit bounded iteration/termination contract', () => {
  const content = richContent();
  const polish = nodesOf(content).find((node) => node.nodeId === 'polish')!;
  polish.loop = null;
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('bounded iteration/termination contract')));
});

test('the iteration bound is finite and hard (0, fractional, oversized bounds rejected)', () => {
  for (const maxIterations of [0, 1.5, 10001]) {
    const content = richContent();
    const polish = nodesOf(content).find((node) => node.nodeId === 'polish')!;
    (polish.loop as { maxIterations: number }).maxIterations = maxIterations;
    const problems = problemsOf(content);
    assert.ok(
      problems.some((p) => p.includes('explicit iteration bound')),
      `maxIterations ${String(maxIterations)} must be rejected`,
    );
  }
});

test('predicate termination requires a predicate reference; count termination carries none', () => {
  const missingRef = richContent();
  const polish = nodesOf(missingRef).find((node) => node.nodeId === 'polish')!;
  (polish.loop as { termination: Record<string, unknown> }).termination = {
    kind: 'predicate',
    predicateRef: null,
  };
  assert.ok(problemsOf(missingRef).some((p) => p.includes('predicate termination requires')));

  const strayRef = richContent();
  const polish2 = nodesOf(strayRef).find((node) => node.nodeId === 'polish')!;
  (polish2.loop as { termination: Record<string, unknown> }).termination = {
    kind: 'count',
    predicateRef: 'policy/leftover',
  };
  assert.ok(problemsOf(strayRef).some((p) => p.includes('only predicate termination carries')));
});

test('an illegal cycle (no loop node anywhere on it) is rejected', () => {
  const content = minimalContent();
  nodesOf(content).push(functionNode('b'), functionNode('c'));
  edgesOf(content).push(successEdge('a', 'b'));
  edgesOf(content).push(successEdge('b', 'c'));
  edgesOf(content).push(successEdge('c', 'b')); // b ⇄ c cycle, no loop node
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('illegal cycle')));
  assert.ok(problems.some((p) => p.includes('explicit bounded loop construct')));
});

test('a cycle that avoids the loop node is rejected even inside a loop region', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('spin', {
      nodeType: 'loop',
      loop: { maxIterations: 4, termination: { kind: 'count', predicateRef: null } },
    }),
    functionNode('p'),
    functionNode('q'),
  );
  edgesOf(content).push(successEdge('a', 'spin'));
  edgesOf(content).push(successEdge('spin', 'p'));
  edgesOf(content).push(successEdge('p', 'q'));
  edgesOf(content).push(successEdge('q', 'p')); // p ⇄ q cycle avoiding the loop node
  edgesOf(content).push(successEdge('q', 't'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('illegal cycle')));
});

test('a cycle routed through the loop node is legal (the bounded loop construct)', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('spin', {
      nodeType: 'loop',
      loop: { maxIterations: 4, termination: { kind: 'count', predicateRef: null } },
    }),
    functionNode('body'),
  );
  edgesOf(content).push(successEdge('a', 'spin'));
  edgesOf(content).push(successEdge('spin', 'body'));
  edgesOf(content).push(successEdge('body', 'spin')); // back edge into the loop node
  edgesOf(content).push(successEdge('spin', 't'));
  assert.deepEqual(problemsOf(content), []);
});

test('a loop construct has a single external entry', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('spin', {
      nodeType: 'loop',
      loop: { maxIterations: 4, termination: { kind: 'count', predicateRef: null } },
    }),
    functionNode('body'),
    functionNode('secondEntry'),
  );
  edgesOf(content).push(successEdge('a', 'spin'));
  edgesOf(content).push(successEdge('a', 'secondEntry'));
  edgesOf(content).push(successEdge('secondEntry', 'spin')); // second external entry
  edgesOf(content).push(successEdge('spin', 'body'));
  edgesOf(content).push(successEdge('body', 'spin'));
  edgesOf(content).push(successEdge('spin', 't'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('single entry')));
});

test('a loop construct with no incoming edge at all is rejected (unreachable)', () => {
  const content = minimalContent();
  nodesOf(content).push(
    functionNode('spin', {
      nodeType: 'loop',
      loop: { maxIterations: 4, termination: { kind: 'count', predicateRef: null } },
    }),
  );
  edgesOf(content).push(successEdge('spin', 't'));
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('a loop construct must be reachable')));
  // spin without an incoming edge is a second (disconnected) entry.
  assert.ok(problems.some((p) => p.includes('exactly one entry node is required')));
});

// ---------------------------------------------------------------------------
// Schema mappings
// ---------------------------------------------------------------------------

test('workflow-input mappings must reference declared input schema properties', () => {
  const content = richContent();
  const generate = nodesOf(content).find((node) => node.nodeId === 'generate')!;
  generate.inputMapping = { topic: { source: 'workflow_input', path: 'topic' } };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes("input property 'topic' is not declared")));
});

test('node-output mappings must reference an existing upstream node', () => {
  const content = richContent();
  const approve = nodesOf(content).find((node) => node.nodeId === 'approve')!;
  approve.inputMapping = { copy: { source: 'node_output', nodeId: 'ghost', path: 'out' } };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('source node ghost does not exist')));
});

test('node-output mappings must reference an ancestor (upstream predecessor)', () => {
  const content = richContent();
  const generate = nodesOf(content).find((node) => node.nodeId === 'generate')!;
  // generate is upstream of nothing — mapping from a downstream node is
  // unresolved (no ordering exists).
  generate.inputMapping = { late: { source: 'node_output', nodeId: 'publish', path: 'url' } };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('not an upstream predecessor')));
});

test('node-output mappings must reference declared output properties of the source node', () => {
  const content = richContent();
  const approve = nodesOf(content).find((node) => node.nodeId === 'approve')!;
  approve.inputMapping = { copy: { source: 'node_output', nodeId: 'generate', path: 'nonexistent' } };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes("does not declare output property 'nonexistent'")));
});

test('workflow-input mappings are unresolvable when the input schema declares no properties', () => {
  const content = richContent();
  const generate = nodesOf(content).find((node) => node.nodeId === 'generate')!;
  generate.inputMapping = { x: { source: 'workflow_input', path: 'anything' } };
  content['inputSchema'] = { ...emptySchema };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes("input property 'anything' is not declared")));
});

test('schema required lists must reference declared properties and stay unique', () => {
  const content = richContent();
  content['inputSchema'] = {
    type: 'object',
    properties: { campaignName: { type: 'string' } },
    required: ['campaignName', 'missing', 'campaignName'],
  };
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('missing is not a declared property')));
  assert.ok(problems.some((p) => p.includes('duplicate entry campaignName')));
});

// ---------------------------------------------------------------------------
// Definition-level policy blocks
// ---------------------------------------------------------------------------

test('retry policy defaults, concurrency limits and timeout policies are bounds-checked', () => {
  const badRetry = richContent();
  badRetry['retryPolicyDefaults'] = { maxAttempts: 0, backoffMs: -1 };
  assert.ok(problemsOf(badRetry).some((p) => p.includes('retryPolicyDefaults.maxAttempts')));

  const badConcurrency = richContent();
  badConcurrency['concurrencyLimits'] = { maxConcurrentWorkflows: 0 };
  assert.ok(problemsOf(badConcurrency).some((p) => p.includes('concurrencyLimits.maxConcurrentWorkflows')));

  const badTimeout = richContent();
  badTimeout['timeoutPolicy'] = { defaultTimeoutSeconds: 3600, maxTimeoutSeconds: 60 };
  assert.ok(problemsOf(badTimeout).some((p) => p.includes('maxTimeoutSeconds cannot be below')));
});

test('missing policy blocks are rejected (they normalize to empty, never to absence)', () => {
  const content = richContent();
  delete content['retryPolicyDefaults'];
  delete content['concurrencyLimits'];
  const problems = problemsOf(content);
  assert.ok(problems.some((p) => p.includes('retryPolicyDefaults: must be an object')));
  assert.ok(problems.some((p) => p.includes('concurrencyLimits: must be an object')));
});

test('compensation declarations reference distinct executable nodes and never self-compensate', () => {
  const unknownNode = richContent();
  unknownNode['compensation'] = [{ nodeId: 'ghost', compensateViaNodeId: 'generate' }];
  assert.ok(problemsOf(unknownNode).some((p) => p.includes('ghost is not a node of this graph')));

  const structuralNode = richContent();
  structuralNode['compensation'] = [{ nodeId: 'gate', compensateViaNodeId: 'generate' }];
  assert.ok(problemsOf(structuralNode).some((p) => p.includes('only executable nodes are compensable')));

  const selfCompensate = richContent();
  selfCompensate['compensation'] = [{ nodeId: 'generate', compensateViaNodeId: 'generate' }];
  assert.ok(problemsOf(selfCompensate).some((p) => p.includes('cannot compensate itself')));

  const duplicate = richContent();
  duplicate['compensation'] = [
    { nodeId: 'publish', compensateViaNodeId: 'generate' },
    { nodeId: 'publish', compensateViaNodeId: 'refine' },
  ];
  assert.ok(problemsOf(duplicate).some((p) => p.includes('duplicate compensation')));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('validation is deterministic — identical input, identical problems', () => {
  const content = richContent();
  content['graph'] = {
    nodes: [...nodesOf(content), functionNode('a')],
    edges: edgesOf(content),
  };
  const first = problemsOf(content);
  const second = problemsOf(content);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
});
