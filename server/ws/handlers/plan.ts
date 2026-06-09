import type { WebSocket } from "ws";
import { broadcast } from "../../state/store.js";
import {
  createPlanNodeFromPayload,
  updatePlanNode,
  deletePlanNode,
  createPlanEdge,
  deletePlanEdge,
} from "../../state/operations.js";
import { safePoint, safeText } from "../../utils/validation.js";
import { debug } from "../../utils/debug.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function handlePlanNodeCreate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const node = createPlanNodeFromPayload({
    nodeId: safeText(message.nodeId),
    kind: message.kind,
    title: message.title,
    body: message.body,
    position: safePoint(message.position),
    userId,
    data: isRecord(message.data) ? message.data : undefined,
  });
  if (!node) { debug("plan:node:create:invalid", { userId }); return; }
  broadcast({ type: "plan:node:created", node });
  debug("plan:node:create", { userId, nodeId: node.id, kind: node.kind });
}

export function handlePlanNodeUpdate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  const patch = message.patch;
  if (!isRecord(patch)) { debug("plan:node:update:invalid", { userId, nodeId }); return; }
  const node = updatePlanNode(nodeId, {
    position: safePoint(patch.position),
    title: patch.title,
    body: patch.body,
    kind: patch.kind,
    data: isRecord(patch.data) ? patch.data : undefined,
  });
  if (!node) { debug("plan:node:update:invalid", { userId, nodeId }); return; }
  broadcast({ type: "plan:node:updated", node });
  debug("plan:node:update", { userId, nodeId });
}

export function handlePlanNodeDelete(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  const edgeIds = deletePlanNode(nodeId);
  if (!edgeIds) { debug("plan:node:delete:invalid", { userId, nodeId }); return; }
  broadcast({ type: "plan:node:deleted", nodeId, edgeIds });
  debug("plan:node:delete", { userId, nodeId, edges: edgeIds.length });
}

export function handlePlanEdgeCreate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const edge = createPlanEdge({
    sourceId: safeText(message.sourceId),
    targetId: safeText(message.targetId),
    label: message.label,
    userId,
  });
  if (!edge) { debug("plan:edge:create:invalid", { userId }); return; }
  broadcast({ type: "plan:edge:created", edge });
  debug("plan:edge:create", { userId, edgeId: edge.id });
}

export function handlePlanEdgeDelete(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const edgeId = safeText(message.edgeId);
  if (!deletePlanEdge(edgeId)) { debug("plan:edge:delete:invalid", { userId, edgeId }); return; }
  broadcast({ type: "plan:edge:deleted", edgeId });
  debug("plan:edge:delete", { userId, edgeId });
}
