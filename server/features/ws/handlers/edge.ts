import type { WebSocket } from "ws";
import { broadcast } from "../../state/store.js";
import { createEdge, deleteEdge } from "../../state/operations.js";
import { safeText } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";

export function handleEdgeCreate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const edge = createEdge({
    edgeId: safeText(message.edgeId),
    sourceId: safeText(message.sourceId),
    targetId: safeText(message.targetId),
    kind: message.kind,
    userId,
  });
  if (!edge) {
    debug("edge:create:invalid", { userId, sourceId: message.sourceId, targetId: message.targetId });
    return;
  }
  broadcast({ type: "edge:created", edge });
  debug("edge:create", { userId, edgeId: edge.id, kind: edge.kind });
}

export function handleEdgeDelete(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const edgeId = safeText(message.edgeId);
  if (!deleteEdge(edgeId)) {
    debug("edge:delete:invalid", { userId, edgeId });
    return;
  }
  broadcast({ type: "edge:deleted", edgeId });
  debug("edge:delete", { userId, edgeId });
}
