import type { WebSocket } from "ws";
import {
  users,
  serializeUsers,
  serializeNodes,
  serializeEdges,
  serializePlanNodes,
  serializePlanEdges,
  serializeNodeRunTraceEvents,
  planExcalidrawData,
  activeRunId,
  send,
  broadcast,
} from "../../state/store.js";
import { safeText } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";
import { NODE_TYPES } from "../../../../src/whiteboard/config/nodeTypes.js";

export function handleJoin(ws: WebSocket, userId: string, message: Record<string, unknown>, fallbackName: string): void {
  const user = users.get(userId);
  if (!user) return;
  user.name = safeText(message.name, fallbackName);
  send(ws, {
    type: "init",
    selfId: userId,
    users: serializeUsers(),
    nodes: serializeNodes(),
    edges: serializeEdges(),
    planElements: planExcalidrawData,
    planNodes: serializePlanNodes(),
    planEdges: serializePlanEdges(),
    nodeRunTraceEvents: serializeNodeRunTraceEvents(),
    activeRunId,
    nodeTypes: NODE_TYPES,
  });
  broadcast({ type: "user:joined", user }, ws);
  debug("join", { userId, name: user.name, users: users.size, nodes: serializeNodes().length });
}
