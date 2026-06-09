import type { WebSocket } from "ws";
import { users, broadcast } from "../../state/store.js";
import { safePoint } from "../../../utils/validation.js";
import { debug } from "../../../utils/debug.js";

function safeWorkspaceTab(value: unknown): "canvas" | "plan" {
  return value === "plan" ? "plan" : "canvas";
}

export function handleCursorUpdate(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const user = users.get(userId);
  if (!user) return;
  user.cursor = safePoint(message.point);
  user.cursorWorkspace = safeWorkspaceTab(message.workspaceTab);
  broadcast({ type: "cursor:update", userId, point: user.cursor, workspaceTab: user.cursorWorkspace }, _ws);
  debug("cursor:update", { userId });
}
