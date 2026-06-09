import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCanvasOperations,
  repairInvalidExistingEdgeOps,
  templateForRequest,
  type CanvasOp,
  type WorkflowSnapshot,
} from "../server/features/workflow/semantics.js";

const start = {
  id: "start_1",
  typeId: "start",
  label: "Start",
  x: 200,
  y: 160,
  config: {},
};

const urlContext = {
  id: "ctx_1",
  typeId: "context",
  label: "Context: jsumarketing.com",
  x: 200,
  y: 296,
  config: {
    sourceType: "url",
    url: "https://jsumarketing.com/",
    notes: "Source website context",
  },
};

const agent = {
  id: "agent_1",
  typeId: "agent",
  label: "Evaluate",
  x: 200,
  y: 448,
  config: { role: "evaluate" },
};

test("normalizes context as side-car input, not executable flow", () => {
  const snapshot: WorkflowSnapshot = {
    nodes: [start, urlContext, agent],
    edges: [],
  };
  const ops: CanvasOp[] = [
    { op: "create_edge", sourceId: "start_1", targetId: "ctx_1", edgeKind: "flow" },
    { op: "create_edge", sourceId: "ctx_1", targetId: "agent_1" },
  ];

  const normalized = normalizeCanvasOperations(ops, snapshot);

  assert.equal(normalized.operations.length, 1);
  assert.equal(normalized.operations[0].sourceId, "ctx_1");
  assert.equal(normalized.operations[0].targetId, "agent_1");
  assert.equal(normalized.operations[0].edgeKind, "context");
  assert.match(normalized.warnings.join("\n"), /Context node/);
});

test("repairs legacy context edges by migrating them to context intent", () => {
  const snapshot: WorkflowSnapshot = {
    nodes: [start, urlContext, agent],
    edges: [
      { id: "edge_bad_target", sourceId: "start_1", targetId: "ctx_1", edgeKind: "flow" },
      { id: "edge_legacy_context", sourceId: "ctx_1", targetId: "agent_1" },
    ],
  };

  const ops = repairInvalidExistingEdgeOps(snapshot);

  assert.deepEqual(ops[0], { op: "delete_edge", edgeId: "edge_bad_target" });
  assert.deepEqual(ops[1], { op: "delete_edge", edgeId: "edge_legacy_context" });
  assert.equal(ops[2].op, "create_edge");
  assert.equal(ops[2].edgeKind, "context");
  assert.equal(ops[2].sourceId, "ctx_1");
  assert.equal(ops[2].targetId, "agent_1");
});

test("bare URL requests create URL context without flow edges", () => {
  const result = templateForRequest("https://jsumarketing.com/", {
    nodes: [start],
    edges: [],
  });

  assert.ok(result);
  assert.ok(result.operations.some((op) =>
    op.op === "create_node" &&
    op.typeId === "context" &&
    op.config?.sourceType === "url" &&
    op.config?.url === "https://jsumarketing.com/"
  ));
  assert.equal(result.operations.some((op) => op.op === "create_edge"), false);
});

test("build-site requests produce the required executable chain shape", () => {
  const result = templateForRequest("make a better website of that", {
    nodes: [start, urlContext],
    edges: [],
  });

  assert.ok(result);
  const labels = result.operations
    .filter((op) => op.op === "create_node")
    .map((op) => op.label);

  assert.deepEqual(labels, [
    "Investigate current site",
    "Plan site improvements",
    "Design improved page",
    "Create improved site",
    "Evaluate site quality",
    "File Write",
  ]);

  const flowEdges = result.operations.filter((op) => op.op === "create_edge" && op.edgeKind === "flow");
  const contextEdges = result.operations.filter((op) => op.op === "create_edge" && op.edgeKind === "context");

  assert.equal(flowEdges.length, 6);
  assert.equal(contextEdges.length, 5);
  assert.ok(contextEdges.every((op) => op.sourceId === "ctx_1"));
  assert.ok(result.operations.some((op) =>
    op.op === "create_node" &&
    op.typeId === "file-write" &&
    op.config?.path === "output/improved-site.html"
  ));
});
