import type { WebSocket } from "ws";
import { broadcast } from "../../state/store.js";
import { createNodeFromPayload, deleteNode, updateNode } from "../../state/operations.js";
import { safePoint, safeText } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";

function nodeTypeFrom(message: Record<string, unknown>): unknown {
  return message.nodeType ?? message.nodeTypeId ?? message.type;
}

export function handleNodeCreate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const node = createNodeFromPayload({
    nodeId: safeText(message.nodeId),
    type: nodeTypeFrom(message),
    position: safePoint(message.position),
    title: message.title ?? message.label,
    config: message.config,
    userId,
  });
  if (!node) {
    debug("node:create:invalid", { userId, nodeType: nodeTypeFrom(message) });
    return;
  }
  broadcast({ type: "node:created", node });
  debug("node:create", { userId, nodeId: node.id, nodeType: node.type });
}

export function handleNodeUpdate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  const configPatch = message.config && typeof message.config === "object" && !Array.isArray(message.config)
    ? message.config as Record<string, unknown>
    : undefined;

  const nextNode = updateNode(nodeId, {
    position: safePoint(message.position) ?? undefined,
    title: message.title ?? message.label,
    config: configPatch as Parameters<typeof updateNode>[1]["config"],
  });
  if (!nextNode) {
    debug("node:update:invalid", { userId, nodeId });
    return;
  }
  broadcast({ type: "node:updated", node: nextNode });
  debug("node:update", { userId, nodeId });
}

export function handleNodeDelete(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = safeText(message.nodeId);
  if (!deleteNode(nodeId)) {
    debug("node:delete:invalid", { userId, nodeId });
    return;
  }
  broadcast({ type: "node:deleted", nodeId });
  debug("node:delete", { userId, nodeId });
}
