import type { WebSocket } from "ws";
import {
  nodes,
  edges,
  planNodes,
  planEdges,
  runHistory,
  workspaceMemory,
  artifacts,
  send,
  broadcast,
} from "../../state/store.js";
import {
  createNodeFromPayload, createEdge,
  updateNode, updateNodeConfig,
  deleteNode, deleteEdge,
  createPlanNodeFromPayload, updatePlanNode,
  deletePlanNode, createPlanEdge, deletePlanEdge,
} from "../../state/operations.js";
import { callOpenAI } from "../../execution/providers/openai.js";
import { NODE_TYPES } from "../../../../src/whiteboard/config/nodeTypes.js";
import { createId } from "../../../utils/id.js";
import { safePoint } from "../../../utils/validation.js";
import {
  normalizeCanvasOperations,
  templateForRequest,
  type CanvasOp,
  type WorkflowSnapshot,
} from "../../workflow/semantics.js";

const NODE_DOCS = NODE_TYPES
  .map(t => `- ${t.id} (${t.label}): ${t.description}`)
  .join("\n");

const SYSTEM_PROMPT = `You are the AI assistant embedded in "DISPATCH.AI" — a visual workflow builder for AI agent chains.

Your personality: helpful, direct, conversational. You talk like a smart colleague, not a robot narrating its actions. Don't say "I'll set up the initial node" or "creating a basic investigate node" — just do it and describe it naturally in past tense or briefly.

For casual conversation ("hi", "how are you", questions about the tool), respond conversationally with NO operations.

For canvas or Plan board requests, respond with JSON. Always respond with ONLY valid JSON when workspace changes are needed — no markdown fences, no extra text outside the JSON.

## Canvas Node Types
${NODE_DOCS}

## Plan Board
The Plan board is separate from the executable workflow canvas.

Important terminology:
- Chat mode "plan" means ask clarifying questions first.
- The Plan board is a planning workspace for notes, tasks, risks, decisions, flowcharts, proposed agents/tools, approval points, and context blocks.
- Context nodes are NOT executable chain steps. They attach to agents with edgeKind "context".
- Execution flow must remain Start → executable node. Never create Start → Context → Agent as the main chain.

Use operations for executable workflow canvas changes.
Use planOperations for Plan board changes.
You may include both arrays only when the user explicitly asks for both a plan artifact and an executable workflow.

Plan node kinds:
note, task, decision, risk, flow-step, proposed-agent, proposed-tool, approval-point, context.

## Config Defaults
- agent: {"role":"investigate","taskPrompt":"","model":"gpt-4o","provider":"openai","tools":["web_search","fetch_url"],"maxToolCalls":6} — role can be: investigate, plan, design, create, evaluate, document, custom. Set taskPrompt to describe what this step should do with its input and context. Configure tools per node: web_search, fetch_url, read_file, write_file, list_files, shell_exec.
- start: {"taskDescription":"...","defaultModel":"gpt-4o","defaultProvider":"openai"}
- branch: {"condition":"describe condition in plain English","provider":"openai","model":"gpt-4o"}
- memory: {"operation":"write","key":"my-key"} — operation: "write" stores input, "read" outputs stored value
- shell-exec: {"command":"npm test","workdir":"","timeout":30000,"outputFormat":"text"}
- file-write: {"path":"output/result.md","mode":"write"} — use workspace-relative paths, never leading slash paths like "/output/result.md"
- context: {"sourceType":"text","content":"","searchQuery":"","notes":"","spreadToChain":false}
- fork, review: {}

## Workflow Semantics
- Use edgeKind "flow" for normal execution edges.
- Use edgeKind "context" only from Context nodes into downstream agents/tools that need the context.
- For "make/build/better website from URL", create this chain: Start → Investigate current site → Plan → Design → Create → Evaluate → File Write, plus context edges from the URL Context node to each agent.
- For "analyze/evaluate site", create Start → Investigate/Evaluate, plus a context edge from URL Context to the agent.
- If the user only sends a URL, create a Context node with {"sourceType":"url","url":"..."} and do not put it in the execution flow.

## Layout
- Grid: multiples of 32. Start at ~x:200,y:160. Space nodes 160-200px vertically.
- Edge ports: Review → "approved"/"rejected", Branch → "true"/"false", all others → "default".
- Never delete the Start node unless the user explicitly asks.

## Response Formats

### Casual conversation (no canvas changes needed):
{"response":"your natural reply here"}

### Auto / Accept mode — canvas and/or Plan board changes:
{"response":"brief natural description of what you did","operations":[...],"planOperations":[...]}

### Plan mode — FIRST turn (ask clarifying questions before doing anything):
{"response":"brief summary of what you'll build","questions":["Specific question 1?","Specific question 2?","Specific question 3?"]}

### Plan mode — after answers provided:
{"response":"building it now","operations":[...],"planOperations":[...]}

## Operations
Use tmpId on create_node to reference new nodes in create_edge within the same batch:
- {"op":"create_node","tmpId":"tmp_1","typeId":"agent","label":"Research","position":{"x":200,"y":320},"config":{"role":"investigate","taskPrompt":"Research this topic using the provided context. Use live search when needed.","model":"gpt-4o","provider":"openai","tools":["web_search","fetch_url"],"maxToolCalls":6}}
- {"op":"update_node","nodeId":"EXISTING_ID","patch":{"label":"...","config":{...}}}
- {"op":"delete_node","nodeId":"EXISTING_ID"}
- {"op":"create_edge","sourceId":"tmp_1","targetId":"EXISTING_ID","sourcePort":"default","edgeKind":"flow"}
- {"op":"create_edge","sourceId":"tmp_context","targetId":"tmp_1","sourcePort":"default","edgeKind":"context"}
- {"op":"delete_edge","edgeId":"EXISTING_ID"}

## Plan Operations
Use tmpId on create_plan_node to reference new plan nodes in create_plan_edge within the same batch:
- {"op":"create_plan_node","tmpId":"plan_tmp_1","kind":"task","title":"Define success criteria","body":"Write measurable acceptance criteria before building.","position":{"x":200,"y":160},"data":{}}
- {"op":"update_plan_node","nodeId":"EXISTING_ID","patch":{"title":"Updated title","body":"Updated details","kind":"decision","position":{"x":232,"y":192},"data":{}}}
- {"op":"delete_plan_node","nodeId":"EXISTING_ID"}
- {"op":"create_plan_edge","sourceId":"plan_tmp_1","targetId":"EXISTING_ID","label":"depends on"}
- {"op":"delete_plan_edge","edgeId":"EXISTING_ID"}

To clear the canvas: delete all nodes except Start (deleting a node auto-removes its edges).`;

interface PlanOp {
  op: string;
  tmpId?: string;
  kind?: string;
  title?: string;
  body?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  nodeId?: string;
  patch?: {
    title?: string;
    body?: string;
    kind?: string;
    position?: { x: number; y: number };
    data?: Record<string, unknown>;
  };
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
  label?: string;
}

export function applyOperations(ops: CanvasOp[], userId: string): void {
  const idMap = new Map<string, string>();

  // Pass 1: create nodes and record tmpId → realId mapping
  for (const op of ops) {
    if (op.op === "create_node" && op.typeId && op.position) {
      const realId = createId("node");
      if (op.tmpId) idMap.set(op.tmpId, realId);
      const node = createNodeFromPayload({
        nodeId: realId,
        typeId: op.typeId,
        position: op.position,
        label: op.label ?? null,
        userId,
        config: op.config,
      });
      if (node) broadcast({ type: "node:created", node });
    }
  }

  // Pass 2: edges, updates, deletes
  for (const op of ops) {
    if (op.op === "create_edge" && op.sourceId && op.targetId) {
      const src = idMap.get(op.sourceId) ?? op.sourceId;
      const tgt = idMap.get(op.targetId) ?? op.targetId;
      const edge = createEdge({
        sourceId: src,
        targetId: tgt,
        userId,
        sourcePort: op.sourcePort ?? "default",
        edgeKind: op.edgeKind,
      });
      if (edge) broadcast({ type: "edge:created", edge });
    } else if (op.op === "update_node" && op.nodeId) {
      const realId = idMap.get(op.nodeId) ?? op.nodeId;
      if (op.patch?.label) updateNode(realId, { label: op.patch.label });
      if (op.patch?.config) updateNodeConfig(realId, op.patch.config);
      const updated = nodes.get(realId);
      if (updated) broadcast({ type: "node:updated", node: updated });
    } else if (op.op === "delete_node" && op.nodeId) {
      const realId = idMap.get(op.nodeId) ?? op.nodeId;
      const edgeIds = deleteNode(realId);
      if (edgeIds) broadcast({ type: "node:deleted", nodeId: realId, edgeIds });
    } else if (op.op === "delete_edge" && op.edgeId) {
      if (deleteEdge(op.edgeId)) broadcast({ type: "edge:deleted", edgeId: op.edgeId });
    }
  }
}

function applyPlanOperations(ops: PlanOp[], userId: string): void {
  const idMap = new Map<string, string>();

  for (const op of ops) {
    if (op.op === "create_plan_node" && op.kind && op.position) {
      const position = safePoint(op.position);
      if (!position) continue;
      const realId = createId("plan");
      if (op.tmpId) idMap.set(op.tmpId, realId);
      const node = createPlanNodeFromPayload({
        nodeId: realId,
        kind: op.kind,
        title: op.title ?? op.kind,
        body: op.body ?? "",
        position,
        userId,
        data: op.data,
      });
      if (node) broadcast({ type: "plan:node:created", node });
    }
  }

  for (const op of ops) {
    if (op.op === "create_plan_edge" && op.sourceId && op.targetId) {
      const src = idMap.get(op.sourceId) ?? op.sourceId;
      const tgt = idMap.get(op.targetId) ?? op.targetId;
      const edge = createPlanEdge({ sourceId: src, targetId: tgt, label: op.label, userId });
      if (edge) broadcast({ type: "plan:edge:created", edge });
    } else if (op.op === "update_plan_node" && op.nodeId && op.patch) {
      const realId = idMap.get(op.nodeId) ?? op.nodeId;
      const patch = sanitizePlanPatch(op.patch);
      if (!patch) continue;
      const node = updatePlanNode(realId, patch);
      if (node) broadcast({ type: "plan:node:updated", node });
    } else if (op.op === "delete_plan_node" && op.nodeId) {
      const realId = idMap.get(op.nodeId) ?? op.nodeId;
      const edgeIds = deletePlanNode(realId);
      if (edgeIds) broadcast({ type: "plan:node:deleted", nodeId: realId, edgeIds });
    } else if (op.op === "delete_plan_edge" && op.edgeId) {
      if (deletePlanEdge(op.edgeId)) broadcast({ type: "plan:edge:deleted", edgeId: op.edgeId });
    }
  }
}

function canvasOpsFrom(value: unknown): CanvasOp[] {
  return Array.isArray(value) ? value as CanvasOp[] : [];
}

function planOpsFrom(value: unknown): PlanOp[] {
  return Array.isArray(value) ? value as PlanOp[] : [];
}

function workflowSnapshot(): WorkflowSnapshot {
  return {
    nodes: Array.from(nodes.values()).map((node) => ({
      id: node.id,
      typeId: node.typeId,
      label: node.label,
      x: node.x,
      y: node.y,
      config: node.config,
    })),
    edges: Array.from(edges.values()).map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      sourcePort: edge.sourcePort,
      edgeKind: edge.edgeKind,
    })),
  };
}

function normalizeForApply(canvasOps: CanvasOp[]): CanvasOp[] {
  return normalizeCanvasOperations(canvasOps, workflowSnapshot()).operations;
}

function sanitizePlanPatch(patch: PlanOp["patch"]): PlanOp["patch"] | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const next: NonNullable<PlanOp["patch"]> = {};
  if (typeof patch.title === "string") next.title = patch.title;
  if (typeof patch.body === "string") next.body = patch.body;
  if (typeof patch.kind === "string") next.kind = patch.kind;
  const position = safePoint(patch.position);
  if (position) next.position = position;
  if (patch.data && typeof patch.data === "object" && !Array.isArray(patch.data)) next.data = patch.data;
  return Object.keys(next).length > 0 ? next : null;
}

export async function handleChatMessage(
  ws: WebSocket,
  userId: string,
  data: Record<string, unknown>
): Promise<void> {
  const content = String(data.content ?? "");
  const mode = String(data.mode ?? "auto");
  const workspaceTab = String(data.workspaceTab ?? "canvas");
  const answers = Array.isArray(data.answers) ? data.answers.map(String) : null;

  const workspaceSnapshot = {
    canvas: {
      nodes: Array.from(nodes.values()).map(n => ({
        id: n.id, typeId: n.typeId, label: n.label,
        x: n.x, y: n.y, config: n.config, status: n.status, output: n.output,
      })),
      edges: Array.from(edges.values()).map(e => ({
        id: e.id, sourceId: e.sourceId, targetId: e.targetId, sourcePort: e.sourcePort, edgeKind: e.edgeKind,
      })),
    },
    plan: {
      nodes: Array.from(planNodes.values()).map(n => ({
        id: n.id, kind: n.kind, title: n.title, body: n.body,
        x: n.x, y: n.y, data: n.data,
      })),
      edges: Array.from(planEdges.values()).map(e => ({
        id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: e.label,
      })),
    },
    memory: Object.fromEntries(workspaceMemory),
    runHistory: runHistory.slice(-5).map((ledger) => ({
      id: ledger.id,
      taskGoal: ledger.taskGoal,
      facts: ledger.facts.slice(-20),
      artifacts: ledger.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        path: artifact.path,
        createdAt: artifact.createdAt,
      })),
      evaluations: ledger.evaluations.slice(-10),
    })),
    artifacts: artifacts.slice(-10).map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      path: artifact.path,
      createdAt: artifact.createdAt,
    })),
  };

  const userMessage = answers?.length
    ? `${content}\n\nAnswers:\n${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    : content;

  const templated = !answers ? templateForRequest(userMessage, workflowSnapshot()) : null;
  if (templated) {
    const canvasOps = normalizeForApply(templated.operations);
    if (mode === "plan") {
      send(ws, {
        type: "chat:response",
        response: templated.response,
        operations: canvasOps,
        planOperations: [],
        responseMode: "preview",
      });
      return;
    }
    if (mode === "accept") {
      send(ws, {
        type: "chat:response",
        response: templated.response,
        operations: canvasOps,
        planOperations: [],
        responseMode: "preview",
      });
      return;
    }
    applyOperations(canvasOps, userId);
    send(ws, { type: "chat:response", response: templated.response, responseMode: "done" });
    return;
  }

  const prompt = `Workspace:\n${JSON.stringify(workspaceSnapshot, null, 2)}\n\nActive workspace tab: ${workspaceTab}\nChat mode: ${mode}\n\nRequest: ${userMessage}`;

  try {
    const raw = await callOpenAI(process.env.OPENAI_CHAT_MODEL ?? process.env.OPENAI_DEFAULT_MODEL ?? "gpt-4o", SYSTEM_PROMPT, prompt);

    let parsed: { response?: string; operations?: CanvasOp[]; planOperations?: PlanOp[]; questions?: string[] };
    try { parsed = JSON.parse(raw) as typeof parsed; }
    catch { parsed = { response: raw }; }

    const canvasOps = normalizeForApply(canvasOpsFrom(parsed.operations));
    const planOps = planOpsFrom(parsed.planOperations);
    const hasOps = canvasOps.length > 0;
    const hasPlanOps = planOps.length > 0;
    const hasAnyOps = hasOps || hasPlanOps;
    const hasQs = Array.isArray(parsed.questions) && parsed.questions.length > 0;

    // Plan mode first turn must never mutate immediately. If the model
    // forgets questions but returns operations, fall back to a review preview.
    if (mode === "plan" && !answers) {
      if (hasQs) {
        send(ws, { type: "chat:response", response: parsed.response, questions: parsed.questions, responseMode: "questions" });
      } else if (hasAnyOps) {
        send(ws, {
          type: "chat:response",
          response: parsed.response ?? "I drafted a proposed change set. Review it before applying.",
          operations: canvasOps,
          planOperations: planOps,
          responseMode: "preview",
        });
      } else {
        send(ws, { type: "chat:response", response: parsed.response ?? raw, responseMode: "done" });
      }
    } else if (hasQs && !answers) {
      send(ws, { type: "chat:response", response: parsed.response, questions: parsed.questions, responseMode: "questions" });
    // Accept/Review mode: send preview without applying
    } else if (hasAnyOps && mode === "accept" && !answers) {
      send(ws, {
        type: "chat:response",
        response: parsed.response,
        operations: canvasOps,
        planOperations: planOps,
        responseMode: "preview",
      });
    // Auto mode or plan-after-answers: apply immediately
    } else if (hasAnyOps) {
      applyOperations(canvasOps, userId);
      applyPlanOperations(planOps, userId);
      send(ws, { type: "chat:response", response: parsed.response, responseMode: "done" });
    // Casual conversation or no-op response
    } else {
      send(ws, { type: "chat:response", response: parsed.response ?? raw, responseMode: "done" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(ws, { type: "chat:error", message: msg });
  }
}

export async function handleChatApply(
  ws: WebSocket,
  userId: string,
  data: Record<string, unknown>
): Promise<void> {
  const ops = canvasOpsFrom(data.operations);
  const safeOps = normalizeForApply(ops);
  const planOps = planOpsFrom(data.planOperations);
  applyOperations(safeOps, userId);
  applyPlanOperations(planOps, userId);
  send(ws, { type: "chat:response", response: "Changes applied.", responseMode: "done" });
}
