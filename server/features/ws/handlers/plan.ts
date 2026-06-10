import type { WebSocket } from "ws";
import { broadcast, send, setPlanExcalidrawData } from "../../state/store.js";

export function handlePlanUpdate(ws: WebSocket, data: Record<string, unknown>): void {
  const elements = typeof data.elements === "string" ? data.elements : null;
  if (!elements || !setPlanExcalidrawData(elements)) {
    send(ws, { type: "plan:error", error: "Invalid Excalidraw plan payload; previous plan was kept." });
    return;
  }
  broadcast({ type: "plan:updated", elements }, ws);
}
