import type { WebSocket } from "ws";
import { nodes, edges, planExcalidrawData, send, broadcast } from "../../state/store.js";
import {
  createNodeFromPayload, createEdge,
  updateNode, updateNodeConfig,
  deleteNode, deleteEdge,
} from "../../state/operations.js";
import { callOpenAI } from "../../execution/providers/openai.js";
import { NODE_TYPES } from "../../../src/whiteboard/config/nodeTypes.js";
import { createId } from "../../utils/id.js";

const NODE_DOCS = NODE_TYPES
  .map(t => `- ${t.id} (${t.label}): ${t.description}`)
  .join("\n");

const SYSTEM_PROMPT = `You are the AI assistant embedded in "DISPATCH.AI" — a visual workflow builder for AI agent chains.

Your personality: helpful, direct, conversational. You talk like a smart colleague, not a robot narrating its actions. Don't say "I'll set up the initial node" or "creating a basic investigate node" — just do it and describe it naturally in past tense or briefly.

For casual conversation ("hi", "how are you", questions about the tool), respond conversationally with NO operations.

For canvas requests, respond with JSON. Always respond with ONLY valid JSON when workspace changes are needed — no markdown fences, no extra text outside the JSON.

## Canvas Node Types
${NODE_DOCS}

## Plan Board
The Plan board is a free-form Excalidraw drawing workspace for sketching ideas. The server does not track individual plan elements — changes are made directly in the browser by the user.

## Config Defaults
- agent: {"role":"investigate","taskPrompt":"","model":"gpt-5.5","provider":"openai","tools":["web_search","fetch_url"],"maxToolCalls":6} — role can be: investigate, plan, design, create, evaluate, document, custom. Set taskPrompt to describe what this step should do with its input and context. Configure tools per node: web_search, fetch_url, read_file, write_file, list_files, shell_exec.
- start: {"taskDescription":"...","defaultModel":"gpt-5.5","defaultProvider":"openai"}
- branch: {"condition":"describe condition in plain English","provider":"openai","model":"gpt-5.5"}
- memory: {"operation":"write","key":"my-key"} — operation: "write" stores input, "read" outputs stored value
- shell-exec: {"command":"npm test","workdir":"","timeout":30000,"outputFormat":"text"}
- file-write: {"path":"output/result.md","mode":"write"} — use workspace-relative paths, never leading slash paths like "/output/result.md"
- context: {"sourceType":"text","content":"","searchQuery":"","notes":"","spreadToChain":false}
- fork, review: {}

## Layout
- Grid: multiples of 32. Start at ~x:200,y:160. Space nodes 160-200px vertically.
- Edge ports: Review → "approved"/"rejected", Branch → "true"/"false", all others → "default".
- Never delete the Start node unless the user explicitly asks.

## Response Formats

### Casual conversation (no canvas changes needed):
{"response":"your natural reply here"}

### Auto / Accept mode — canvas changes:
{"response":"brief natural description of what you did","operations":[...]}

### Plan mode — FIRST turn (ask clarifying questions before doing anything):
{"response":"brief summary of what you'll build","questions":["Specific question 1?","Specific question 2?","Specific question 3?"]}

### Plan mode — after answers provided:
{"response":"building it now","operations":[...]}

## Operations
Use tmpId on create_node to reference new nodes in create_edge within the same batch:
- {"op":"create_node","tmpId":"tmp_1","typeId":"agent","label":"Research","position":{"x":200,"y":320},"config":{"role":"investigate","taskPrompt":"Research this topic using the provided context. Use live search when needed.","model":"gpt-5.5","provider":"openai","tools":["web_search","fetch_url"],"maxToolCalls":6}}
- {"op":"update_node","nodeId":"EXISTING_ID","patch":{"label":"...","config":{...}}}
- {"op":"delete_node","nodeId":"EXISTING_ID"}
- {"op":"create_edge","sourceId":"tmp_1","targetId":"EXISTING_ID","sourcePort":"default"}
- {"op":"delete_edge","edgeId":"EXISTING_ID"}

To clear the canvas: delete all nodes except Start (deleting a node auto-removes its edges).`;

interface CanvasOp {
  op: string;
  tmpId?: string;
  typeId?: string;
  label?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  nodeId?: string;
  patch?: { label?: string; config?: Record<string, unknown> };
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
  sourcePort?: string;
}

function applyOperations(ops: CanvasOp[], userId: string): void {
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
      const edge = createEdge({ sourceId: src, targetId: tgt, userId, sourcePort: op.sourcePort ?? "default" });
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

function canvasOpsFrom(value: unknown): CanvasOp[] {
  return Array.isArray(value) ? value as CanvasOp[] : [];
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
        x: n.x, y: n.y, config: n.config, status: n.status,
      })),
      edges: Array.from(edges.values()).map(e => ({
        id: e.id, sourceId: e.sourceId, targetId: e.targetId, sourcePort: e.sourcePort,
      })),
    },
    plan: {
      elementsCount: (() => { try { const a = JSON.parse(planExcalidrawData); return Array.isArray(a) ? a.length : 0; } catch { return 0; } })(),
    },
  };

  const userMessage = answers?.length
    ? `${content}\n\nAnswers:\n${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    : content;

  const prompt = `Workspace:\n${JSON.stringify(workspaceSnapshot, null, 2)}\n\nActive workspace tab: ${workspaceTab}\nChat mode: ${mode}\n\nRequest: ${userMessage}`;

  try {
    const raw = await callOpenAI("gpt-5.5", SYSTEM_PROMPT, prompt);

    let parsed: { response?: string; operations?: CanvasOp[]; questions?: string[] };
    try { parsed = JSON.parse(raw) as typeof parsed; }
    catch { parsed = { response: raw }; }

    const canvasOps = canvasOpsFrom(parsed.operations);
    const hasOps = canvasOps.length > 0;
    const hasQs = Array.isArray(parsed.questions) && parsed.questions.length > 0;

    // Plan mode first turn must never mutate immediately. If the model
    // forgets questions but returns operations, fall back to a review preview.
    if (mode === "plan" && !answers) {
      if (hasQs) {
        send(ws, { type: "chat:response", response: parsed.response, questions: parsed.questions, responseMode: "questions" });
      } else if (hasOps) {
        send(ws, {
          type: "chat:response",
          response: parsed.response ?? "I drafted a proposed change set. Review it before applying.",
          operations: canvasOps,
          responseMode: "preview",
        });
      } else {
        send(ws, { type: "chat:response", response: parsed.response ?? raw, responseMode: "done" });
      }
    } else if (hasQs && !answers) {
      send(ws, { type: "chat:response", response: parsed.response, questions: parsed.questions, responseMode: "questions" });
    // Accept/Review mode: send preview without applying
    } else if (hasOps && mode === "accept" && !answers) {
      send(ws, {
        type: "chat:response",
        response: parsed.response,
        operations: canvasOps,
        responseMode: "preview",
      });
    // Auto mode or plan-after-answers: apply immediately
    } else if (hasOps) {
      applyOperations(canvasOps, userId);
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
  applyOperations(ops, userId);
  send(ws, { type: "chat:response", response: "Changes applied.", responseMode: "done" });
}
