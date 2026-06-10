import type { WebSocket } from "ws";
import { debug } from "../../utils/debug.js";
import { users } from "../state/store.js";
import { handleCursorUpdate } from "./handlers/cursor.js";
import { handleJoin } from "./handlers/join.js";
import { handleNodeCreate, handleNodeDelete, handleNodeUpdate } from "./handlers/node.js";
import { handleEdgeCreate, handleEdgeDelete } from "./handlers/edge.js";
import { handleChainRun, handleChainRetry, handleChainStop } from "./handlers/chain.js";
import { handleReviewRespond } from "./handlers/review.js";
import { handlePlanUpdate } from "./handlers/plan.js";
import { handleChatMessage, handleChatApply } from "./handlers/chat.js";

export function dispatchMessage(ws: WebSocket, userId: string, raw: Buffer): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw.toString()) as Record<string, unknown>;
  } catch {
    debug("invalid-json", { userId });
    return;
  }

  if (!message || typeof message.type !== "string") {
    debug("invalid-message", { userId });
    return;
  }

  const user = users.get(userId);
  const fallbackName = user?.name ?? "Guest";

  switch (message.type) {
    case "join":          return handleJoin(ws, userId, message, fallbackName);
    case "cursor:update": return handleCursorUpdate(ws, userId, message);
    case "node:create":   return handleNodeCreate(ws, userId, message);
    case "node:update":   return handleNodeUpdate(ws, userId, message);
    case "node:delete":   return handleNodeDelete(ws, userId, message);
    case "edge:create":   return handleEdgeCreate(ws, userId, message);
    case "edge:delete":   return handleEdgeDelete(ws, userId, message);
    case "chain:run":     return handleChainRun(ws, userId, message);
    case "chain:retry":   return handleChainRetry(ws, userId, message);
    case "chain:stop":    return handleChainStop(ws, userId, message);
    case "review:respond": return handleReviewRespond(ws, userId, message);
    case "plan:update":   return handlePlanUpdate(ws, message);
    case "chat:message":  void handleChatMessage(ws, userId, message); return;
    case "chat:apply":    return handleChatApply(ws, userId, message);
    default:
      debug("unknown-message", { userId, type: message.type });
  }
}
