import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import type { WebSocket } from "ws";
import { CHAT_SYSTEM_PROMPT } from "../server/features/chat/chatProvider.js";
import { serializeGraph } from "../server/features/chat/graphSerializer.js";
import {
  canRepairEvaluationFailure,
  containsFileMap,
  evaluateFailureMessage,
  materializeContractFailureMessage,
} from "../server/features/execution/engine.js";
import { buildWritePlan } from "../server/features/execution/materializeSafe.js";
import { loadSkill } from "../server/features/execution/skillLoader.js";
import { createEdge, createNodeFromPayload, deleteNode, updateNode } from "../server/features/state/operations.js";
import {
  appendChatMessage,
  clients,
  edges,
  hydrateWorkspaceState,
  nodes,
  persistWorkspaceState,
  resetWorkspaceForTests,
  setPlanExcalidrawData,
  setWorkspaceStateFileForTests,
  users,
  workspaceStateSnapshot,
} from "../server/features/state/store.js";
import { NODE_REGISTRY } from "../shared/nodeRegistry.js";
import { handleChatApply } from "../server/features/ws/handlers/chat.js";
import { handleJoin } from "../server/features/ws/handlers/join.js";
import { handleNodeCreate, handleNodeDelete, handleNodeUpdate } from "../server/features/ws/handlers/node.js";
import { handlePlanUpdate } from "../server/features/ws/handlers/plan.js";

class FakeSocket {
  OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }
}

function fakeWs(): WebSocket & FakeSocket {
  return new FakeSocket() as WebSocket & FakeSocket;
}

beforeEach(() => {
  resetWorkspaceForTests();
  clients.clear();
  users.clear();
});

test("Node V2 creates one Initialiser and rejects duplicates", () => {
  const first = createNodeFromPayload({
    type: "initialiser",
    position: { x: 10, y: 20 },
    title: "Start here",
    userId: "user_1",
  });
  assert.ok(first);
  assert.equal(first.type, "initialiser");
  assert.equal(first.title, "Start here");
  assert.equal(nodes.size, 1);

  const second = createNodeFromPayload({
    type: "initialiser",
    position: { x: 80, y: 120 },
    userId: "user_1",
  });
  assert.equal(second, null);
  assert.equal(nodes.size, 1);
});

test("Node V2 rejects unknown node types", () => {
  const node = createNodeFromPayload({
    type: "agent",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  assert.equal(node, null);
  assert.equal(nodes.size, 0);
});

test("Node V2 updates title and position", () => {
  const node = createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  assert.ok(node);

  const updated = updateNode(node.id, {
    title: "Renamed",
    position: { x: 41, y: 67 },
  });
  assert.ok(updated);
  assert.equal(updated.title, "Renamed");
  assert.equal(updated.x, 32);
  assert.equal(updated.y, 64);
});

test("Node V2 can delete and recreate the Initialiser", () => {
  const node = createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  assert.ok(node);
  assert.equal(deleteNode(node.id), true);
  assert.equal(nodes.size, 0);

  const recreated = createNodeFromPayload({
    type: "initialiser",
    position: { x: 64, y: 64 },
    userId: "user_1",
  });
  assert.ok(recreated);
  assert.equal(nodes.size, 1);
});

test("workspace snapshot persists v2 nodes and plan elements", () => {
  createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  setPlanExcalidrawData('[{"id":"plan-1"}]');

  const snapshot = workspaceStateSnapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.planElements, '[{"id":"plan-1"}]');
  assert.ok(Array.isArray(snapshot.chatMessages));
});

test("workspace persistence stores durable graph state and reloads reject edges", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-state-"));
  const stateFile = path.join(stateDir, "workspace-state.json");
  setWorkspaceStateFileForTests(stateFile);

  const initialiser = createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  const review = createNodeFromPayload({
    type: "review",
    position: { x: 0, y: 160 },
    userId: "user_1",
  });
  const create = createNodeFromPayload({
    type: "create",
    position: { x: 0, y: 320 },
    userId: "user_1",
  });
  assert.ok(initialiser);
  assert.ok(review);
  assert.ok(create);

  const rejectEdge = createEdge({
    sourceId: review.id,
    targetId: create.id,
    kind: "reject",
    userId: "user_1",
  });
  assert.ok(rejectEdge);
  assert.equal(updateNode(create.id, { status: "done", output: "large runtime output" })?.status, "done");

  assert.equal(persistWorkspaceState(), true);
  const beforeRuntimeUpdate = readFileSync(stateFile, "utf-8");
  const persisted = JSON.parse(beforeRuntimeUpdate) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  const persistedCreate = persisted.nodes.find((node) => node.id === create.id);
  assert.equal(persistedCreate?.status, "idle");
  assert.equal(persistedCreate?.output, null);
  assert.equal(persisted.edges.some((edge) => edge.kind === "reject"), true);

  updateNode(create.id, { status: "error", output: "do not write this to disk" });
  assert.equal(readFileSync(stateFile, "utf-8"), beforeRuntimeUpdate);

  nodes.clear();
  edges.clear();
  assert.equal(hydrateWorkspaceState(), true);
  assert.equal(nodes.get(create.id)?.status, "idle");
  assert.equal(nodes.get(create.id)?.output, null);
  assert.equal(Array.from(edges.values()).some((edge) => edge.kind === "reject"), true);
});

test("corrupt workspace state is quarantined instead of default-saved", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-corrupt-"));
  const stateFile = path.join(stateDir, "workspace-state.json");
  writeFileSync(stateFile, "{ nope", "utf-8");
  setWorkspaceStateFileForTests(stateFile);

  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(hydrateWorkspaceState(), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(existsSync(stateFile), false);
  assert.equal(readdirSync(stateDir).some((file) => file.startsWith("workspace-state.corrupt.")), true);
  assert.equal(nodes.size, 0);
});

test("invalid plan updates are rejected without wiping saved plan elements", () => {
  const ws = fakeWs();
  assert.equal(setPlanExcalidrawData('[{"id":"plan-1"}]'), true);

  handlePlanUpdate(ws, { type: "plan:update", elements: "not json" });

  assert.equal(workspaceStateSnapshot().planElements, '[{"id":"plan-1"}]');
  assert.equal((ws.sent[0] as Record<string, unknown>).type, "plan:error");
});

test("init payload sends Node V2 workspace with nodes and edges (no legacy fields)", () => {
  const ws = fakeWs();
  users.set("user_1", {
    id: "user_1",
    name: "Guest",
    color: "#000",
    cursor: null,
  });
  createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  setPlanExcalidrawData('[{"id":"plan-1"}]');
  appendChatMessage("user", "remember the review gate");
  appendChatMessage("assistant", "I will keep that in workspace memory.");

  handleJoin(ws, "user_1", { name: "Ada" }, "Guest");

  const init = ws.sent[0] as Record<string, unknown>;
  assert.equal(init.type, "init");
  assert.equal(Array.isArray(init.nodes), true);
  assert.equal(Array.isArray(init.edges), true);
  assert.equal(init.planElements, '[{"id":"plan-1"}]');
  assert.equal(Array.isArray(init.chatMessages), true);
  assert.match(JSON.stringify(init.chatMessages), /review gate/i);
  assert.equal("nodeTypes" in init, false);
  assert.equal("planNodes" in init, false);
  assert.equal("planEdges" in init, false);
});

test("graph serializer includes edge ids and endpoint ids for chat tools", () => {
  const init = createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    userId: "user_1",
  });
  const investigate = createNodeFromPayload({
    type: "investigate",
    position: { x: 0, y: 160 },
    title: "Investigate Adam Bell",
    config: { taskPrompt: "Research Adam Bell." },
    userId: "user_1",
  });
  assert.ok(init);
  assert.ok(investigate);
  const edge = createEdge({ sourceId: init.id, targetId: investigate.id, kind: "flow", userId: "user_1" });
  assert.ok(edge);

  const graph = serializeGraph(nodes, edges);

  assert.match(graph, new RegExp(`id:${edge.id}`));
  assert.match(graph, new RegExp(init.id));
  assert.match(graph, new RegExp(investigate.id));
});

test("node websocket handlers broadcast Node V2 state", () => {
  const ws = fakeWs();
  clients.set(ws, "user_1");

  handleNodeCreate(ws, "user_1", {
    type: "node:create",
    nodeType: "initialiser",
    nodeId: "node_1",
    position: { x: 0, y: 0 },
    title: "Initialiser",
  });
  assert.equal((ws.sent[0] as Record<string, unknown>).type, "node:created");

  handleNodeUpdate(ws, "user_1", {
    type: "node:update",
    nodeId: "node_1",
    position: { x: 70, y: 70 },
    title: "Updated",
  });
  const updated = ws.sent[1] as Record<string, unknown>;
  assert.equal(updated.type, "node:updated");
  assert.equal((updated.node as Record<string, unknown>).title, "Updated");

  handleNodeDelete(ws, "user_1", { type: "node:delete", nodeId: "node_1" });
  assert.equal((ws.sent[2] as Record<string, unknown>).type, "node:deleted");
});

test("chat prompt favors full build chains without vague follow-ups", () => {
  assert.match(CHAT_SYSTEM_PROMPT, /Do not ask a vague follow-up/i);
  assert.match(CHAT_SYSTEM_PROMPT, /portfolio\/build requests/i);
  assert.match(
    CHAT_SYSTEM_PROMPT,
    /Initialiser -> Investigate -> Plan -> Design -> Create -> Evaluate -> Apply/
  );
  assert.match(CHAT_SYSTEM_PROMPT, /friendly, concise, and conversational/i);
  assert.match(CHAT_SYSTEM_PROMPT, /insert_node_between/i);
  assert.match(CHAT_SYSTEM_PROMPT, /delete_edge_between/i);
});

test("chat apply sends an applied event and assistant acknowledgement", () => {
  const ws = fakeWs();

  handleChatApply(ws, "user_1", {
    type: "chat:apply",
    operations: [
      {
        op: "create_node",
        tempId: "init",
        nodeType: "initialiser",
        title: "Portfolio Initialiser",
        config: { workspacePath: "./portfolio" },
      },
      {
        op: "create_node",
        tempId: "create",
        nodeType: "create",
        title: "Build Portfolio",
        config: { taskPrompt: "Create a portfolio site implementation and output a file map." },
      },
      {
        op: "create_node",
        tempId: "apply",
        nodeType: "apply",
        title: "Write Files",
      },
      { op: "create_edge", tempId: "edge-1", sourceId: "init", targetId: "create", kind: "flow" },
      { op: "create_edge", tempId: "edge-2", sourceId: "create", targetId: "apply", kind: "flow" },
    ],
  });

  assert.equal(nodes.size, 3);
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(ws.sent[0], { type: "chat:applied" });
  assert.equal((ws.sent[1] as Record<string, unknown>).type, "chat:done");
  assert.match(String((ws.sent[1] as Record<string, unknown>).text), /applied 5 workflow changes/i);
});

test("chat apply refuses invalid operations before mutating the graph", () => {
  const ws = fakeWs();

  handleChatApply(ws, "user_1", {
    type: "chat:apply",
    operations: [
      {
        op: "create_node",
        tempId: "create",
        nodeType: "create",
        title: "Build Portfolio",
        config: { taskPrompt: "Create a portfolio site implementation." },
      },
    ],
  });

  assert.equal(nodes.size, 0);
  assert.equal(ws.sent.length, 1);
  const response = ws.sent[0] as Record<string, unknown>;
  assert.equal(response.type, "chat:done");
  assert.match(String(response.text), /couldn't apply/i);
  assert.match(String(response.error), /No Initialiser node/i);
});

test("chat apply resolves synthetic source-target edge ids when inserting review gates", () => {
  const ws = fakeWs();
  const init = createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    config: { workspacePath: "./portfolio" },
    userId: "user_1",
  });
  const investigate = createNodeFromPayload({
    type: "investigate",
    position: { x: 0, y: 160 },
    title: "Investigate Adam Bell",
    config: { taskPrompt: "Research verified facts about Adam Bell." },
    userId: "user_1",
  });
  const plan = createNodeFromPayload({
    type: "plan",
    position: { x: 0, y: 320 },
    title: "Plan Portfolio Website",
    config: { taskPrompt: "Plan the portfolio from approved research." },
    userId: "user_1",
  });
  assert.ok(init);
  assert.ok(investigate);
  assert.ok(plan);
  assert.ok(createEdge({ sourceId: init.id, targetId: investigate.id, kind: "flow", userId: "user_1" }));
  const edge = createEdge({ sourceId: investigate.id, targetId: plan.id, kind: "flow", userId: "user_1" });
  assert.ok(edge);

  handleChatApply(ws, "user_1", {
    type: "chat:apply",
    operations: [
      {
        op: "create_node",
        tempId: "review-gate",
        nodeType: "review",
        title: "Approve Research",
      },
      {
        op: "delete_edge",
        edgeId: `${investigate.id}-${plan.id}`,
      },
      {
        op: "create_edge",
        tempId: "investigate-review",
        sourceId: investigate.id,
        targetId: "review-gate",
        kind: "flow",
      },
      {
        op: "create_edge",
        tempId: "review-plan",
        sourceId: "review-gate",
        targetId: plan.id,
        kind: "flow",
      },
    ],
  });

  assert.equal((ws.sent[0] as Record<string, unknown>).type, "chat:applied");
  assert.equal(edges.has(edge.id), false);
  const review = Array.from(nodes.values()).find((node) => node.type === "review");
  assert.ok(review);
  assert.equal(Array.from(edges.values()).some((e) => e.sourceId === investigate.id && e.targetId === review.id), true);
  assert.equal(Array.from(edges.values()).some((e) => e.sourceId === review.id && e.targetId === plan.id), true);
});

test("chat apply supports high-level insert_node_between operations", () => {
  const ws = fakeWs();
  const init = createNodeFromPayload({
    type: "initialiser",
    position: { x: 0, y: 0 },
    config: { workspacePath: "./portfolio" },
    userId: "user_1",
  });
  const investigate = createNodeFromPayload({
    type: "investigate",
    position: { x: 0, y: 160 },
    title: "Investigate Adam Bell",
    config: { taskPrompt: "Research verified facts about Adam Bell." },
    userId: "user_1",
  });
  const plan = createNodeFromPayload({
    type: "plan",
    position: { x: 0, y: 320 },
    title: "Plan Portfolio Website",
    config: { taskPrompt: "Plan the portfolio from approved research." },
    userId: "user_1",
  });
  assert.ok(init);
  assert.ok(investigate);
  assert.ok(plan);
  assert.ok(createEdge({ sourceId: init.id, targetId: investigate.id, kind: "flow", userId: "user_1" }));
  const originalEdge = createEdge({ sourceId: investigate.id, targetId: plan.id, kind: "flow", userId: "user_1" });
  assert.ok(originalEdge);

  handleChatApply(ws, "user_1", {
    type: "chat:apply",
    operations: [
      {
        op: "insert_node_between",
        tempId: "review-gate",
        nodeType: "review",
        sourceId: "Investigate Adam Bell",
        targetId: "Plan Portfolio Website",
        title: "Approve Research",
      },
    ],
  });

  assert.equal((ws.sent[0] as Record<string, unknown>).type, "chat:applied");
  assert.equal(edges.has(originalEdge.id), false);
  const review = Array.from(nodes.values()).find((node) => node.type === "review");
  assert.ok(review);
  assert.equal(Array.from(edges.values()).some((e) => e.sourceId === investigate.id && e.targetId === review.id), true);
  assert.equal(Array.from(edges.values()).some((e) => e.sourceId === review.id && e.targetId === plan.id), true);
});

test("Evaluate skill checks spec compliance, not just file block existence", () => {
  const skill = loadSkill("evaluate");

  assert.match(skill.systemPrompt, /VERDICT: PASS/i);
  assert.match(skill.systemPrompt, /VERDICT: FAIL/i);
  assert.match(skill.systemPrompt, /Spec compliance/i);
  assert.match(skill.systemPrompt, /placeholder/i);
});

test("Evaluate FAIL stops the chain before Materialize", () => {
  const fail = evaluateFailureMessage("**VERDICT: FAIL**\n\n**Issues Found**:\n- Missing file map.");
  assert.ok(fail);
  assert.match(fail, /Evaluate failed/i);
  assert.match(fail, /Missing file map/i);

  assert.equal(evaluateFailureMessage("**VERDICT: PASS**\n\nLooks good."), null);
});

test("Create skill uses file tools and forbids placeholders", () => {
  const skill = loadSkill("create");

  assert.ok(skill.meta.tools?.includes("file_tools"), "create must declare file_tools");
  assert.match(skill.systemPrompt, /create_file/i);
  assert.match(skill.systemPrompt, /no placeholders/i);
});

test("Create and Evaluate cannot feed Materialize without file maps", () => {
  const create = createNodeFromPayload({
    type: "create",
    position: { x: 0, y: 0 },
    title: "Create Portfolio Website Code",
    userId: "user_1",
  });
  const evaluate = createNodeFromPayload({
    type: "evaluate",
    position: { x: 0, y: 160 },
    title: "Evaluate Portfolio Website",
    userId: "user_1",
  });
  const materialize = createNodeFromPayload({
    type: "apply",
    position: { x: 0, y: 320 },
    title: "Materialize Portfolio Website",
    userId: "user_1",
  });
  assert.ok(create);
  assert.ok(evaluate);
  assert.ok(materialize);
  assert.ok(createEdge({ sourceId: create.id, targetId: evaluate.id, kind: "flow", userId: "user_1" }));
  assert.ok(createEdge({ sourceId: evaluate.id, targetId: materialize.id, kind: "flow", userId: "user_1" }));

  assert.equal(containsFileMap("--- FILE: index.html ---\n<html></html>"), true);
  assert.match(
    materializeContractFailureMessage(create, "Here is the website implementation.") ?? "",
    /Create "Create Portfolio Website Code" feeds Materialize/
  );
  assert.equal(
    materializeContractFailureMessage(evaluate, "VERDICT: PASS\n\nWhat Works:\n- Looks good."),
    null
  );
  assert.equal(
    materializeContractFailureMessage(create, "--- FILE: index.html ---\n<html></html>"),
    null
  );
});

test("Materialize explains PASS verdicts without file delimiters", () => {
  const plan = buildWritePlan("VERDICT: PASS\n\nWhat Works:\n- Component structure is solid.", ".");

  assert.equal(plan.files.length, 0);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /Evaluate PASS verdict without any file delimiters/);
  assert.match(plan.errors[0], /pass through the complete Create file map/);
});

test("skillLoader parses frontmatter and returns meta alongside systemPrompt", () => {
  const skill = loadSkill("create");
  assert.ok(skill.systemPrompt.length > 0);
  assert.ok(skill.meta);
  assert.ok(typeof skill.meta.temperature === "number");
  assert.ok(skill.meta.temperature! < 0.5, "create should have low temperature for deterministic output");
});

test("investigate skill is configured with web_search tool", () => {
  const skill = loadSkill("investigate");
  assert.ok(skill.meta.tools?.includes("web_search"), "investigate must declare web_search tool");
});

test("canRepairEvaluationFailure respects MAX_EVALUATE_REPAIR_ATTEMPTS=0", () => {
  assert.equal(canRepairEvaluationFailure(0), false);
  assert.equal(canRepairEvaluationFailure(1), false);
});
