import type { WebSocket } from "ws";
import { debug } from "../utils/debug.js";
import { handleJoin } from "./handlers/join.js";
import { handleNodeCreate, handleNodeUpdate, handleNodeDelete, handleNodeConfigUpdate } from "./handlers/node.js";
import { handleEdgeCreate, handleEdgeDelete } from "./handlers/edge.js";
import { handleCursorUpdate } from "./handlers/cursor.js";
import { handleChainRun, handleChainStop, handleReviewApprove, handleReviewReject, handleToolApprovalApprove, handleToolApprovalDeny } from "./handlers/chain.js";
import { handleChatMessage, handleChatApply } from "./handlers/chat.js";
import { handlePlanUpdate } from "./handlers/plan.js";
import { handleSkillList, handleSkillUpdate } from "./handlers/skill.js";
import { users } from "../state/store.js";

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
  const fallbackName = user?.name ?? `Guest`;

  switch (message.type) {
    case "join":           return handleJoin(ws, userId, message, fallbackName);
    case "cursor:update":  return handleCursorUpdate(ws, userId, message);
    case "node:create":        return handleNodeCreate(ws, userId, message);
    case "node:update":        return handleNodeUpdate(ws, userId, message);
    case "node:delete":        return handleNodeDelete(ws, userId, message);
    case "node:config:update": return handleNodeConfigUpdate(ws, userId, message);
    case "edge:create":        return handleEdgeCreate(ws, userId, message);
    case "edge:delete":        return handleEdgeDelete(ws, userId, message);
    case "plan:update":        return handlePlanUpdate(ws, { elements: typeof message.elements === "string" ? message.elements : "[]" });
    case "chain:run":          return handleChainRun(ws, userId);
    case "chain:stop":         return handleChainStop(ws, userId);
    case "review:approve":           return handleReviewApprove(ws, userId, message);
    case "review:reject":            return handleReviewReject(ws, userId, message);
    case "tool:approval:approve":    return handleToolApprovalApprove(ws, userId, message);
    case "tool:approval:deny":       return handleToolApprovalDeny(ws, userId, message);
    case "chat:message":       void handleChatMessage(ws, userId, message); return;
    case "chat:apply":         void handleChatApply(ws, userId, message); return;
    case "skill:list":         void handleSkillList(ws); return;
    case "skill:update":       void handleSkillUpdate(ws, message); return;
    default: debug("unknown-message", { userId, type: message.type });
  }
}
