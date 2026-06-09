import type { WebSocket } from "ws";
import { broadcast } from "../../state/store.js";
import { createNodeFromPayload, updateNode, deleteNode, updateNodeConfig } from "../../state/operations.js";
import { safeText, safePoint } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";

export function handleNodeCreate(ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const node = createNodeFromPayload({
    nodeId: safeText(message.nodeId),
    typeId: safeText(message.nodeTypeId),
    position: safePoint(message.position),
    label: message.label,
    userId,
    config: message.config && typeof message.config === "object" && !Array.isArray(message.config)
      ? message.config as Record<string, unknown>
      : undefined,
  });
  if (!node) { debug("node:create:invalid", { userId, nodeTypeId: message.nodeTypeId }); return; }
  broadcast({ type: "node:created", node });
  debug("node:create", { userId, nodeId: node.id, nodeTypeId: node.typeId });
}

export function handleNodeUpdate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  const nextNode = updateNode(nodeId, {
    position: safePoint(message.position) ?? undefined,
    label: typeof message.label === "string" ? message.label : undefined,
  });
  if (!nextNode) { debug("node:update:invalid", { userId, nodeId }); return; }
  broadcast({ type: "node:updated", node: nextNode });
  debug("node:update", { userId, nodeId });
}

export function handleNodeDelete(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  const removedEdgeIds = deleteNode(nodeId);
  if (!removedEdgeIds) { debug("node:delete:invalid", { userId, nodeId }); return; }
  broadcast({ type: "node:deleted", nodeId, edgeIds: removedEdgeIds });
  debug("node:delete", { userId, nodeId, edges: removedEdgeIds.length });
}

export function handleNodeConfigUpdate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  const config = message.config as Record<string, unknown>;
  if (!config || typeof config !== "object") { debug("node:config:invalid", { userId }); return; }
  const next = updateNodeConfig(nodeId, config);
  if (!next) { debug("node:config:invalid", { userId, nodeId }); return; }
  broadcast({ type: "node:config:updated", node: next });
  debug("node:config:update", { userId, nodeId });
}
