import type { WebSocket } from "ws";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { EdgeV2Kind, NodeV2Type } from "../../../../shared/types.js";
import { send, broadcast, nodes, edges, chatTranscript, appendChatMessage } from "../../state/store.js";
import { createNodeFromPayload, createEdge, updateNode, deleteNode, deleteEdge } from "../../state/operations.js";
import { serializeGraph } from "../../chat/graphSerializer.js";
import { validateGraph } from "../../chat/graphValidator.js";
import { simulateOperations } from "../../chat/graphSimulator.js";
import { computeLayoutForBatch } from "../../chat/graphLayout.js";
import type { ChatGraphOperation } from "../../chat/graphSimulator.js";
import { callChatModel, CHAT_SYSTEM_PROMPT } from "../../chat/chatProvider.js";

function modelHistory(): ChatCompletionMessageParam[] {
  return chatTranscript.slice(-40).map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
}

function proposalText(text: string, summary: string | undefined): string {
  if (text.trim()) return text;
  const summaryText = typeof summary === "string" ? summary.trim() : "";
  return summaryText
    ? `I can set that up as a focused workflow: ${summaryText}. Review the proposed changes and apply them when you're ready.`
    : "I can set that up as a focused workflow. Review the proposed changes and apply them when you're ready.";
}

function textOrFallback(text: string, fallback: string): string {
  return text.trim() ? text : fallback;
}

function applyAcknowledgement(operations: ChatGraphOperation[]): string {
  const count = operations.length;
  if (count === 1) return "Done, I applied that workflow change to the canvas.";
  return `Done, I applied ${count} workflow changes to the canvas.`;
}


const BUILD_CHAIN: Array<{
  type: NodeV2Type;
  title: string;
  taskPrompt?: (userText: string) => string;
}> = [
  {
    type: "investigate",
    title: "Research requirements",
    taskPrompt: (userText) =>
      `Research the subject, audience, source material, and constraints for this request. Capture concrete facts and references needed downstream.\n\nUser request: ${userText}`,
  },
  {
    type: "plan",
    title: "Plan website",
    taskPrompt: (userText) =>
      `Create a practical implementation plan, page/content structure, and acceptance criteria for the requested build.\n\nUser request: ${userText}`,
  },
  {
    type: "design",
    title: "Design experience",
    taskPrompt: (userText) =>
      `Design the UI/UX direction, layout system, visual hierarchy, responsive behavior, and Tailwind CSS styling approach for the requested build.\n\nUser request: ${userText}`,
  },
  {
    type: "create",
    title: "Create implementation",
    taskPrompt: (userText) =>
      `Build the complete implementation. Pull real content directly from the Investigate node output — names, projects, skills, roles, links, achievements — and use it. Never use placeholder text or "add verified X here" copy. If something wasn't researched, make a sensible design choice and build it anyway. Output a complete file-map using --- FILE: path --- delimiters for every file.\n\nUser request: ${userText}`,
  },
  {
    type: "evaluate",
    title: "Evaluate output",
    taskPrompt: () =>
      `Check if the upstream output contains --- FILE: path --- blocks with complete file content. If it does, respond with exactly: VERDICT: PASS. If there are no file blocks at all, respond with: VERDICT: FAIL — no file map found.`,
  },
  { type: "apply", title: "Write files" },
];

function isBuildWorkflowRequest(userText: string): boolean {
  return /\b(build|make|create|implement|generate|scaffold)\b/i.test(userText)
    && /\b(portfolio|website|web\s*site|site|web\s*app|app|tool|project)\b/i.test(userText);
}

function operationId(op: ChatGraphOperation): string | null {
  if (op.op === "create_node") return op.tempId;
  if (op.op === "update_node" || op.op === "delete_node") return op.nodeId;
  if (op.op === "create_edge") return op.tempId;
  if (op.op === "delete_edge") return op.edgeId;
  if (op.op === "delete_edge_between") return `${op.sourceId}->${op.targetId}:${op.kind ?? "any"}`;
  if (op.op === "insert_node_between") return op.tempId;
  return null;
}

function cloneOperation(op: ChatGraphOperation): ChatGraphOperation {
  if (op.op === "create_node") return { ...op, config: op.config ? { ...op.config } : undefined };
  if (op.op === "update_node") return { ...op, config: op.config ? { ...op.config } : undefined };
  if (op.op === "insert_node_between") return { ...op, config: op.config ? { ...op.config } : undefined };
  return { ...op };
}

interface NormalizedOpsResult {
  operations: ChatGraphOperation[];
  errors: string[];
}

function normText(value: string): string {
  return value.trim().toLowerCase();
}

function isEdgeKind(value: unknown): value is EdgeV2Kind {
  return value === "flow" || value === "midput" || value === "reject";
}

function operationTempIds(operations: ChatGraphOperation[]): Set<string> {
  const ids = new Set<string>();
  for (const op of operations) {
    if ((op.op === "create_node" || op.op === "insert_node_between") && op.tempId) ids.add(op.tempId);
  }
  return ids;
}

function resolveNodeRef(ref: string, tempIds: Set<string>): string {
  const value = ref.trim();
  if (!value) return ref;
  if (tempIds.has(value)) return value;
  if (nodes.has(value)) return value;

  const target = normText(value);
  const titleMatches = Array.from(nodes.values()).filter((node) => normText(node.title) === target);
  if (titleMatches.length === 1) return titleMatches[0].id;

  const typeMatches = Array.from(nodes.values()).filter((node) => node.type === target);
  if (typeMatches.length === 1) return typeMatches[0].id;

  const labelMatches = Array.from(nodes.values()).filter((node) => {
    const canonical = `${node.type} ${node.title}`;
    return normText(canonical) === target;
  });
  if (labelMatches.length === 1) return labelMatches[0].id;

  return ref;
}

function findExistingEdgeId(
  edgeRef: string | undefined,
  sourceRef: string | undefined,
  targetRef: string | undefined,
  kind: EdgeV2Kind | undefined,
  tempIds: Set<string>
): string | null {
  if (edgeRef) {
    const trimmed = edgeRef.trim();
    if (edges.has(trimmed)) return trimmed;
    for (const [edgeId, edge] of edges) {
      const syntheticRefs = [
        `${edge.sourceId}-${edge.targetId}`,
        `${edge.sourceId}->${edge.targetId}`,
        `${edge.sourceId}:${edge.targetId}`,
        `${edge.sourceId}:${edge.targetId}:${edge.kind}`,
      ];
      if (syntheticRefs.includes(trimmed) && (!kind || edge.kind === kind)) return edgeId;
    }
  }

  if (!sourceRef || !targetRef) return null;
  const sourceId = resolveNodeRef(sourceRef, tempIds);
  const targetId = resolveNodeRef(targetRef, tempIds);
  for (const [edgeId, edge] of edges) {
    if (
      edge.sourceId === sourceId &&
      edge.targetId === targetId &&
      (!kind || edge.kind === kind)
    ) {
      return edgeId;
    }
  }
  return null;
}

function normalizeChatOperationsForGraph(operations: ChatGraphOperation[]): NormalizedOpsResult {
  const tempIds = operationTempIds(operations);
  const normalized: ChatGraphOperation[] = [];
  const errors: string[] = [];
  const deletedEdgeIds = new Set<string>();

  function pushDeleteEdge(edgeId: string): void {
    if (deletedEdgeIds.has(edgeId)) return;
    deletedEdgeIds.add(edgeId);
    normalized.push({ op: "delete_edge", edgeId });
  }

  for (const rawOp of operations) {
    const op = cloneOperation(rawOp);

    if (op.op === "create_edge") {
      normalized.push({
        ...op,
        sourceId: resolveNodeRef(op.sourceId, tempIds),
        targetId: resolveNodeRef(op.targetId, tempIds),
      });
      continue;
    }

    if (op.op === "update_node") {
      normalized.push({ ...op, nodeId: resolveNodeRef(op.nodeId, tempIds) });
      continue;
    }

    if (op.op === "delete_node") {
      normalized.push({ ...op, nodeId: resolveNodeRef(op.nodeId, tempIds) });
      continue;
    }

    if (op.op === "delete_edge") {
      const edgeId = findExistingEdgeId(op.edgeId, op.sourceId, op.targetId, op.kind, tempIds);
      if (edgeId) {
        pushDeleteEdge(edgeId);
      } else {
        normalized.push({
          ...op,
          sourceId: op.sourceId ? resolveNodeRef(op.sourceId, tempIds) : undefined,
          targetId: op.targetId ? resolveNodeRef(op.targetId, tempIds) : undefined,
        });
      }
      continue;
    }

    if (op.op === "delete_edge_between") {
      const edgeId = findExistingEdgeId(undefined, op.sourceId, op.targetId, op.kind, tempIds);
      if (edgeId) {
        pushDeleteEdge(edgeId);
      } else {
        errors.push(`Edge not found between "${op.sourceId}" and "${op.targetId}".`);
      }
      continue;
    }

    if (op.op === "insert_node_between") {
      const sourceId = resolveNodeRef(op.sourceId, tempIds);
      const targetId = resolveNodeRef(op.targetId, tempIds);
      const edgeId = findExistingEdgeId(undefined, sourceId, targetId, op.kind ?? "flow", tempIds)
        ?? findExistingEdgeId(undefined, sourceId, targetId, undefined, tempIds);
      const existingEdge = edgeId ? edges.get(edgeId) : null;
      if (!edgeId || !existingEdge) {
        errors.push(`Edge not found between "${op.sourceId}" and "${op.targetId}".`);
        continue;
      }

      pushDeleteEdge(edgeId);
      normalized.push({
        op: "create_node",
        tempId: op.tempId,
        nodeType: op.nodeType,
        title: op.title,
        config: op.config,
      });
      normalized.push({
        op: "create_edge",
        tempId: `${op.tempId}-in`,
        sourceId: existingEdge.sourceId,
        targetId: op.tempId,
        kind: existingEdge.kind,
      });
      normalized.push({
        op: "create_edge",
        tempId: `${op.tempId}-out`,
        sourceId: op.tempId,
        targetId: existingEdge.targetId,
        kind: existingEdge.kind === "reject" ? "flow" : existingEdge.kind,
      });
      continue;
    }

    normalized.push(op);
  }

  return { operations: normalized, errors };
}

function normalizeBuildProposal(
  userText: string,
  operations: ChatGraphOperation[],
  summary: string
): { operations: ChatGraphOperation[]; summary: string } {
  if (!isBuildWorkflowRequest(userText)) return { operations, summary };

  const existingInitialiser = Array.from(nodes.values()).find((node) => node.type === "initialiser") ?? null;
  const redirects = new Map<string, string>();
  const normalized: ChatGraphOperation[] = [];

  for (const rawOp of operations) {
    const op = cloneOperation(rawOp);
    if (op.op === "create_node" && op.nodeType === "initialiser" && existingInitialiser) {
      redirects.set(op.tempId, existingInitialiser.id);
      continue;
    }
    normalized.push(op);
  }

  function resolveId(id: string): string {
    return redirects.get(id) ?? id;
  }

  for (const op of normalized) {
    if (op.op === "create_edge") {
      op.sourceId = resolveId(op.sourceId);
      op.targetId = resolveId(op.targetId);
    }
  }

  const createdByType = new Map<NodeV2Type, Extract<ChatGraphOperation, { op: "create_node" }>>();
  for (const op of normalized) {
    if (op.op === "create_node" && !createdByType.has(op.nodeType)) {
      createdByType.set(op.nodeType, op);
    }
  }

  const existingByType = new Map<NodeV2Type, string>();
  for (const node of nodes.values()) {
    if (!existingByType.has(node.type)) existingByType.set(node.type, node.id);
  }

  function ensureNode(type: NodeV2Type, title: string, taskPrompt?: string): string {
    const created = createdByType.get(type);
    if (created) {
      created.title = created.title || title;
      if (taskPrompt) {
        // BUILD_CHAIN task prompts always override the model's generated ones
        created.config = { ...(created.config ?? {}), taskPrompt };
      }
      return created.tempId;
    }

    const existingId = existingByType.get(type);
    if (existingId) {
      if (taskPrompt) {
        normalized.push({ op: "update_node", nodeId: existingId, config: { taskPrompt } });
      }
      return existingId;
    }

    const tempId = `auto-${type}`;
    const op: Extract<ChatGraphOperation, { op: "create_node" }> = {
      op: "create_node",
      tempId,
      nodeType: type,
      title,
      config: taskPrompt ? { taskPrompt } : undefined,
    };
    normalized.push(op);
    createdByType.set(type, op);
    return tempId;
  }

  let initialiserId: string;
  if (existingInitialiser) {
    initialiserId = existingInitialiser.id;
    const existingContent = existingInitialiser.config?.content?.trim() ?? "";
    if (!existingContent.includes(userText.trim())) {
      normalized.push({ op: "update_node", nodeId: existingInitialiser.id, config: { content: userText } });
    }
  } else {
    const createdInitialiser = createdByType.get("initialiser");
    if (createdInitialiser) {
      initialiserId = createdInitialiser.tempId;
      createdInitialiser.config = {
        ...(createdInitialiser.config ?? {}),
        workspacePath: createdInitialiser.config?.workspacePath?.trim() ? createdInitialiser.config.workspacePath : "./workspace",
        content: userText,
      };
    } else {
      initialiserId = "auto-initialiser";
      normalized.unshift({
        op: "create_node",
        tempId: initialiserId,
        nodeType: "initialiser",
        title: "Initialiser",
        config: { workspacePath: "./workspace", content: userText },
      });
    }
  }

  const chainIds = [initialiserId];
  for (const spec of BUILD_CHAIN) {
    chainIds.push(ensureNode(spec.type, spec.title, spec.taskPrompt?.(userText)));
  }

  function hasFlowEdge(sourceId: string, targetId: string): boolean {
    const source = resolveId(sourceId);
    const target = resolveId(targetId);
    for (const edge of edges.values()) {
      if (edge.kind === "flow" && edge.sourceId === source && edge.targetId === target) return true;
    }
    return normalized.some((op) => (
      op.op === "create_edge"
      && op.kind === "flow"
      && resolveId(op.sourceId) === source
      && resolveId(op.targetId) === target
    ));
  }

  let edgeCounter = 1;
  for (let i = 0; i < chainIds.length - 1; i++) {
    const sourceId = chainIds[i];
    const targetId = chainIds[i + 1];
    if (hasFlowEdge(sourceId, targetId)) continue;
    normalized.push({
      op: "create_edge",
      tempId: `auto-flow-${edgeCounter++}`,
      sourceId,
      targetId,
      kind: "flow",
    });
  }

  const normalizedIds = new Set(normalized.map(operationId).filter(Boolean));
  const changed = normalized.length !== operations.length
    || operations.some((op, index) => operationId(op) !== operationId(normalized[index] ?? op))
    || normalizedIds.size !== new Set(operations.map(operationId).filter(Boolean)).size;

  return {
    operations: normalized,
    summary: changed
      ? "Create full build chain: Initialiser -> Investigate -> Plan -> Design -> Create -> Evaluate -> Apply"
      : summary,
  };
}

export async function handleChatMessage(
  ws: WebSocket,
  _userId: string,
  data: Record<string, unknown>
): Promise<void> {
  const rawUserText = String(data.content ?? "").trim();
  if (!rawUserText) return;

  const userText = rawUserText;

  const history = modelHistory();
  appendChatMessage("user", rawUserText);

  // Build context-rich user turn — fresh graph state every time
  const graphContext = serializeGraph(nodes, edges);
  const issues = validateGraph(nodes, edges);
  const issuesText = issues.length > 0
    ? `\nGRAPH ISSUES:\n${issues.map((i) => `  [${i.kind}] ${i.message}`).join("\n")}`
    : "";

  const fullUserContent = `${graphContext}${issuesText}\n\n---\nUSER: ${userText}`;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: fullUserContent },
  ];

  try {
    const { text, toolName, toolArgs } = await callChatModel(messages, (chunk) => {
      send(ws, { type: "chat:chunk", text: chunk });
    });
    let assistantHistoryText = text || "(no text)";

    if (toolName === "propose_operations" && toolArgs) {
      const { summary, operations } = toolArgs as { summary: string; operations: ChatGraphOperation[] };
      const resolved = normalizeChatOperationsForGraph(Array.isArray(operations) ? operations : []);
      const buildNormalized = normalizeBuildProposal(userText, resolved.operations, summary);
      const resolvedFinal = normalizeChatOperationsForGraph(buildNormalized.operations);
      const finalOperations = resolvedFinal.operations;
      const operationErrors = [...resolved.errors, ...resolvedFinal.errors];
      const finalText = proposalText(text, buildNormalized.summary);
      assistantHistoryText = finalText;

      const simResult = simulateOperations(nodes, edges, finalOperations);

      if (operationErrors.length > 0 || simResult.errors.length > 0) {
        const errorText = textOrFallback(text, "I tried to build an operation plan, but it failed validation.");
        assistantHistoryText = errorText;
        send(ws, {
          type: "chat:done",
          text: errorText,
          error: [...operationErrors, ...simResult.errors].join(". "),
        });
      } else {
        const blockingErrors = validateGraph(simResult.nodes, simResult.edges)
          .filter((i) => i.kind === "error");
        if (blockingErrors.length > 0) {
          const errorText = textOrFallback(text, "These changes would leave the graph in an invalid state.");
          assistantHistoryText = errorText;
          send(ws, {
            type: "chat:done",
            text: errorText,
            error: blockingErrors.map((i) => i.message).join(". "),
          });
        } else {
          send(ws, {
            type: "chat:done",
            text: finalText,
            pendingOps: finalOperations,
            pendingSummary: buildNormalized.summary,
          });
        }
      }
    } else if (toolName === "execute_command" && toolArgs) {
      const { command, nodeId } = toolArgs as { command: string; nodeId?: string };
      send(ws, { type: "chat:done", text, command, commandNodeId: nodeId ?? null });
    } else {
      send(ws, { type: "chat:done", text });
    }

    // Store compact history (plain words only, not graph dump)
    appendChatMessage("assistant", assistantHistoryText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendChatMessage("assistant", `Chat error: ${message}`);
    send(ws, { type: "chat:error", message });
  }
}

export function handleChatApply(
  ws: WebSocket,
  userId: string,
  data: Record<string, unknown>
): void {
  const rawOps = data.operations;
  if (!Array.isArray(rawOps)) return;

  const normalized = normalizeChatOperationsForGraph(rawOps as ChatGraphOperation[]);
  if (normalized.errors.length > 0) {
    send(ws, {
      type: "chat:done",
      text: "I couldn't apply those changes because I couldn't resolve part of the graph edit.",
      error: normalized.errors.join(". "),
    });
    return;
  }

  const operations = normalized.operations;

  const simResult = simulateOperations(nodes, edges, operations);
  if (simResult.errors.length > 0) {
    send(ws, {
      type: "chat:done",
      text: "I couldn't apply those changes because they no longer validate.",
      error: simResult.errors.join(". "),
    });
    return;
  }

  const blockingErrors = validateGraph(simResult.nodes, simResult.edges)
    .filter((i) => i.kind === "error");
  if (blockingErrors.length > 0) {
    send(ws, {
      type: "chat:done",
      text: "I couldn't apply those changes because they would leave the graph invalid.",
      error: blockingErrors.map((i) => i.message).join(". "),
    });
    return;
  }

  // Extract create ops for layout computation
  const createNodeOps = operations.filter(
    (op): op is Extract<ChatGraphOperation, { op: "create_node" }> => op.op === "create_node"
  );
  const createEdgeOps = operations.filter(
    (op): op is Extract<ChatGraphOperation, { op: "create_edge" }> => op.op === "create_edge"
  );

  const layoutPositions = computeLayoutForBatch(
    nodes,
    createNodeOps.map((op) => ({ tempId: op.tempId, nodeType: op.nodeType })),
    createEdgeOps.map((op) => ({ sourceId: op.sourceId, targetId: op.targetId, kind: op.kind }))
  );

  // tempId → real id map, built as we create nodes/edges
  const tempIdToRealId = new Map<string, string>();

  function resolveId(id: string): string {
    return tempIdToRealId.get(id) ?? id;
  }

  for (const op of operations) {
    if (op.op === "create_node") {
      const pos = layoutPositions.get(op.tempId) ?? op.position ?? { x: 400, y: 200 };
      const node = createNodeFromPayload({
        type: op.nodeType,
        position: pos,
        title: op.title,
        config: op.config,
        userId,
      });
      if (node) {
        tempIdToRealId.set(op.tempId, node.id);
        broadcast({ type: "node:created", node });
      }
    }

    else if (op.op === "update_node") {
      const realId = resolveId(op.nodeId);
      const updated = updateNode(realId, { title: op.title, config: op.config });
      if (updated) broadcast({ type: "node:updated", node: updated });
    }

    else if (op.op === "delete_node") {
      const realId = resolveId(op.nodeId);
      // Collect related edge IDs before deleteNode removes them internally
      const relatedEdgeIds = Array.from(edges.entries())
        .filter(([, e]) => e.sourceId === realId || e.targetId === realId)
        .map(([id]) => id);
      for (const eid of relatedEdgeIds) broadcast({ type: "edge:deleted", edgeId: eid });
      if (deleteNode(realId)) broadcast({ type: "node:deleted", nodeId: realId });
    }

    else if (op.op === "create_edge") {
      const realSourceId = resolveId(op.sourceId);
      const realTargetId = resolveId(op.targetId);
      const edge = createEdge({ sourceId: realSourceId, targetId: realTargetId, kind: op.kind, userId });
      if (edge) {
        tempIdToRealId.set(op.tempId, edge.id);
        broadcast({ type: "edge:created", edge });
      }
    }

    else if (op.op === "delete_edge") {
      const realId = resolveId(op.edgeId);
      if (deleteEdge(realId)) broadcast({ type: "edge:deleted", edgeId: realId });
    }
  }

  send(ws, { type: "chat:applied" });
  send(ws, { type: "chat:done", text: applyAcknowledgement(operations) });
}
