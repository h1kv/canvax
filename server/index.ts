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
