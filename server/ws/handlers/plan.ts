import type { WebSocket } from "ws";
import { broadcast, setPlanExcalidrawData } from "../../state/store.js";

// plan:update { elements: string } — elements is JSON-stringified Excalidraw elements array
export function handlePlanUpdate(ws: WebSocket, data: { elements: string }): void {
  setPlanExcalidrawData(data.elements);
  // Broadcast to all other clients
  broadcast({ type: "plan:updated", elements: data.elements }, ws);
}
