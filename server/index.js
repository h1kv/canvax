import express from "express";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const clients = new Map();
const strokes = new Map();
const users = new Map();

const userColors = ["#2d2d2d", "#7c3f3f", "#4f6b45", "#7a612e", "#6a4f76", "#7a4f5b"];
const shouldDebugWebSockets = !isProduction;
const debugColors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
let colorIndex = 0;

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, 40) || fallback;
}

function safePoint(point) {
  if (!point || typeof point !== "object") return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function formatDebugValue(value) {
  if (typeof value === "number") return Number(value.toFixed(2));
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  if (typeof value === "string" && value.includes(" ")) return `"${value}"`;
  return value;
}

function getDebugColor(event) {
  if (event.includes("invalid") || event.includes("ignored")) return debugColors.red;
  if (event === "close") return debugColors.yellow;
  if (event === "connection" || event === "join") return debugColors.green;
  if (event.startsWith("stroke:")) return debugColors.magenta;
  if (event.startsWith("cursor:")) return debugColors.gray;
  return debugColors.cyan;
}

function debugWebSocket(event, details = {}) {
  if (!shouldDebugWebSockets) return;

  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(" ");

  const color = getDebugColor(event);
  const suffix = fields ? ` ${debugColors.dim}${fields}${debugColors.reset}` : "";
  console.log(`${color}[ws] ${event}${debugColors.reset}${suffix}`);
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(message, exceptWs = null) {
  const encoded = JSON.stringify(message);
  for (const ws of clients.keys()) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) {
      ws.send(encoded);
    }
  }
}

function serializeUsers() {
  return Array.from(users.values());
}

function serializeStrokes() {
  return Array.from(strokes.values());
}

function eraseStrokes(ids) {
  const erasedIds = [];
  for (const id of ids) {
    if (typeof id === "string" && strokes.delete(id)) {
      erasedIds.push(id);
    }
  }
  return erasedIds;
}

function undoLatestUserStroke(userId) {
  const userStrokes = Array.from(strokes.values()).filter((stroke) => stroke.userId === userId);
  const latestStroke = userStrokes.at(-1);

  if (!latestStroke) return null;

  strokes.delete(latestStroke.id);
  return latestStroke.id;
}

wss.on("connection", (ws) => {
  const userId = createId("user");
  const fallbackName = `Guest ${users.size + 1}`;
  const user = {
    id: userId,
    name: fallbackName,
    color: userColors[colorIndex % userColors.length],
    cursor: null
  };

  colorIndex += 1;
  clients.set(ws, userId);
  users.set(userId, user);
  debugWebSocket("connection", { userId, clients: clients.size });

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      debugWebSocket("invalid-json", { userId });
      return;
    }

    if (!message || typeof message.type !== "string") {
      debugWebSocket("invalid-message", { userId });
      return;
    }

    if (message.type === "join") {
      user.name = safeText(message.name, fallbackName);
      send(ws, {
        type: "init",
        selfId: userId,
        users: serializeUsers(),
        strokes: serializeStrokes()
      });
      broadcast({ type: "user:joined", user }, ws);
      debugWebSocket("join", { userId, name: user.name, users: users.size, strokes: strokes.size });
      return;
    }

    if (message.type === "cursor:update") {
      const point = safePoint(message.point);
      user.cursor = point;
      broadcast({ type: "cursor:update", userId, point }, ws);
      debugWebSocket("cursor:update", { userId });
      return;
    }

    if (message.type === "stroke:start") {
      const strokeId = safeText(message.stroke?.id, createId("stroke"));
      const point = safePoint(message.stroke?.point);
      if (!point) {
        debugWebSocket("stroke:start:invalid-point", { userId, strokeId });
        return;
      }

      const stroke = {
        id: strokeId,
        userId,
        userName: user.name,
        color: safeText(message.stroke.color, "#1f1f1f"),
        size: Number(message.stroke.size) || 4,
        points: [point],
        createdAt: Date.now()
      };

      strokes.set(stroke.id, stroke);
      broadcast({ type: "stroke:start", stroke }, ws);
      debugWebSocket("stroke:start", { userId, strokeId: stroke.id, size: stroke.size, color: stroke.color });
      return;
    }

    if (message.type === "stroke:point") {
      const strokeId = safeText(message.strokeId);
      const point = safePoint(message.point);
      const stroke = strokes.get(strokeId);
      if (!point || !stroke || stroke.userId !== userId) {
        debugWebSocket("stroke:point:ignored", { userId, strokeId });
        return;
      }

      stroke.points.push(point);
      broadcast({ type: "stroke:point", strokeId, point }, ws);
      debugWebSocket("stroke:point", { userId, strokeId, points: stroke.points.length });
      return;
    }

    if (message.type === "stroke:end") {
      const strokeId = safeText(message.strokeId);
      const stroke = strokes.get(strokeId);
      if (!stroke || stroke.userId !== userId) {
        debugWebSocket("stroke:end:ignored", { userId, strokeId });
        return;
      }

      broadcast({ type: "stroke:end", strokeId }, ws);
      debugWebSocket("stroke:end", { userId, strokeId, points: stroke.points.length });
      return;
    }

    if (message.type === "stroke:erase") {
      const erasedIds = Array.isArray(message.strokeIds) ? eraseStrokes(message.strokeIds) : [];
      if (erasedIds.length > 0) {
        broadcast({ type: "stroke:erase", strokeIds: erasedIds }, ws);
      }
      debugWebSocket("stroke:erase", { userId, count: erasedIds.length, strokeIds: erasedIds });
      return;
    }

    if (message.type === "stroke:undo") {
      const strokeId = undoLatestUserStroke(userId);
      if (strokeId) {
        broadcast({ type: "stroke:undo", strokeId });
      }
      debugWebSocket("stroke:undo", { userId, strokeId: strokeId || "none" });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    users.delete(userId);
    broadcast({ type: "user:left", userId });
    debugWebSocket("close", { userId, name: user.name, clients: clients.size });
  });
});

if (isProduction) {
  app.use(express.static(path.join(rootDir, "dist")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(rootDir, "dist", "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa"
  });

  app.use(vite.middlewares);
}

function getLocalAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

server.listen(port, "0.0.0.0", () => {
  const localUrls = getLocalAddresses().map((address) => `http://${address}:${port}`);

  console.log(`canvax running at http://localhost:${port}`);
  if (shouldDebugWebSockets) {
    console.log(`${debugColors.cyan}[ws] debug logging enabled${debugColors.reset}`);
  }
  if (localUrls.length > 0) {
    console.log("Local network URLs:");
    for (const url of localUrls) {
      console.log(`  ${url}`);
    }
  }
});
