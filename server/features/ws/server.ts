import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { clients, users, userColors, colorIndex, incrementColorIndex, broadcast } from "../state/store.js";
import { createId } from "../../utils/id.js";
import { debug } from "../../utils/debug.js";
import { dispatchMessage } from "./dispatch.js";

export function setupWebSocketServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    const userId = createId("user");
    const fallbackName = `Guest ${users.size + 1}`;
    const user = {
      id: userId,
      name: fallbackName,
      color: userColors[colorIndex % userColors.length],
      cursor: null,
    };

    incrementColorIndex();
    clients.set(ws, userId);
    users.set(userId, user);
    debug("connection", { userId, clients: clients.size });

    ws.on("message", (raw) => dispatchMessage(ws, userId, raw as Buffer));

    ws.on("close", () => {
      clients.delete(ws);
      users.delete(userId);
      broadcast({ type: "user:left", userId });
      debug("close", { userId, name: user.name, clients: clients.size });
    });
  });
}
