import type { WebSocket } from "ws";
import {
  broadcast,
  planExcalidrawData,
  send,
  serializeChatMessages,
  serializeEdges,
  serializeNodes,
  serializeUsers,
  users,
} from "../../state/store.js";
import { safeText } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";
import { loadAllSkillMeta } from "../../execution/skillLoader.js";
import { SDLC_NODE_TYPES } from "../../../../shared/nodeRegistry.js";

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
    chatMessages: serializeChatMessages(),
    skillsMeta: loadAllSkillMeta(SDLC_NODE_TYPES),
  });
  broadcast({ type: "user:joined", user }, ws);
  debug("join", { userId, name: user.name, users: users.size, nodes: serializeNodes().length });
}
