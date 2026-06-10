import express from "express";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupWebSocketServer } from "./features/ws/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);

const app = express();
const server = createServer(app);

setupWebSocketServer(server);

app.use(express.json());

app.post("/api/realtime-session", async (req, res) => {
  const apiKey = process.env.RTM_OPENAI;
  if (!apiKey) { res.status(500).json({ error: "RTM_OPENAI not set" }); return; }
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
        instructions: "You are a helpful, conversational AI assistant on the DISPATCH.AI platform. Be concise, warm, and direct. Help the user think through their workflow, answer questions, and discuss ideas out loud.",
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
      }),
    });
    const data = await r.json() as Record<string, unknown>;
    if (!r.ok) { res.status(r.status).json(data); return; }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Guard: reject any /preview requests that try to escape into server internals
app.use("/preview", (req, res, next) => {
  const decoded = decodeURIComponent(req.path);
  if (/^\/(server|src|node_modules)(\/|$)/.test(decoded) || decoded.startsWith("/.")) {
    res.status(403).end();
    return;
  }
  next();
});
// Serve materialized workspace files — path-safe since express.static handles traversal
app.use("/preview", express.static(rootDir, { index: "index.html" }));

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
    appType: "spa",
  });
  app.use(vite.middlewares);
}

function getLocalAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((e): e is os.NetworkInterfaceInfo => !!e && e.family === "IPv4" && !e.internal)
    .map((e) => e.address);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`DISPATCH.AI running at http://localhost:${port}`);
  if (!isProduction) console.log("\x1b[36m[ws] debug logging enabled\x1b[0m");
  const localUrls = getLocalAddresses();
  if (localUrls.length > 0) {
    console.log("Local network URLs:");
    for (const url of localUrls) console.log(`  http://${url}:${port}`);
  }
});
