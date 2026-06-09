import type { WebSocket } from "ws";
import { broadcast } from "../../state/store.js";
import { createEdge, deleteEdge } from "../../state/operations.js";
import { safeText } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";
import type { EdgeKind } from "../../../../shared/types.js";

function safeEdgeKind(value: unknown): EdgeKind | undefined {
  return value === "context" || value === "flow" ? value : undefined;
}

export function handleEdgeCreate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const edge = createEdge({
    sourceId: safeText(message.sourceId),
    targetId: safeText(message.targetId),
    sourcePort: safeText(message.sourcePort, "default"),
    edgeKind: safeEdgeKind(message.edgeKind),
    userId,
  });
  if (!edge) { debug("edge:create:invalid", { userId }); return; }
  broadcast({ type: "edge:created", edge });
  debug("edge:create", { userId, edgeId: edge.id, sourceId: edge.sourceId, targetId: edge.targetId });
}

export function handleEdgeDelete(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const edgeId = safeText(message.edgeId);
  if (!deleteEdge(edgeId)) { debug("edge:delete:invalid", { userId, edgeId }); return; }
  broadcast({ type: "edge:deleted", edgeId });
  debug("edge:delete", { userId, edgeId });
}
