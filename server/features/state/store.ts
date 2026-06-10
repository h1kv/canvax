import type { WebSocket } from "ws";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getNodeDefinition } from "../../../shared/nodeRegistry.js";
import type {
  BoardUser,
  ChatTranscriptMessage,
  EdgeV2,
  EdgeV2Kind,
  NodeV2,
  NodeV2Config,
  NodeV2Type,
  WorkspaceStateV2,
  WorkspaceTab,
} from "../../../shared/types.js";
import { createId } from "../../utils/id.js";

export interface ServerUser extends BoardUser {}

export const clients = new Map<WebSocket, string>();
export const users = new Map<string, ServerUser>();
export const nodes = new Map<string, NodeV2>();
export const edges = new Map<string, EdgeV2>();
export let chatTranscript: ChatTranscriptMessage[] = [];
export let planExcalidrawData = "[]";

const DEFAULT_PLAN_ELEMENTS = "[]";
const MAX_CHAT_TRANSCRIPT_MESSAGES = 80;
const WORKSPACE_STATE_FILE_NAME = "workspace-state.json";
let workspaceStateFileOverride: string | null = null;
let persistenceSuspended = true; // TEMP: persistence disabled

export const userColors = ["#2d2d2d", "#7c3f3f", "#4f6b45", "#7a612e", "#6a4f76", "#7a4f5b"];
export let colorIndex = 0;
export function incrementColorIndex(): void { colorIndex++; }

export function serializeUsers(): ServerUser[] { return Array.from(users.values()); }
export function serializeNodes(): NodeV2[] { return Array.from(nodes.values()); }
export function serializeEdges(): EdgeV2[] { return Array.from(edges.values()); }
export function serializeChatMessages(): ChatTranscriptMessage[] { return chatTranscript.map((msg) => ({ ...msg })); }

function workspaceStateFile(): string {
  if (workspaceStateFileOverride) return workspaceStateFileOverride;
  if (process.env.DISPATCH_WORKSPACE_STATE_FILE) return process.env.DISPATCH_WORKSPACE_STATE_FILE;
  return path.join(process.env.DISPATCH_WORKSPACE_STATE_DIR ?? path.join(process.cwd(), ".dispatch"), WORKSPACE_STATE_FILE_NAME);
}

function workspaceStateDir(): string {
  return path.dirname(workspaceStateFile());
}

function normalizePlanElements(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return Array.isArray(JSON.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function setPlanExcalidrawData(data: string): boolean {
  const normalized = normalizePlanElements(data);
  if (normalized === null) return false;
  planExcalidrawData = normalized;
  persistWorkspaceState();
  return true;
}

function sanitizeConfig(value: unknown, defaults: NodeV2Config): NodeV2Config {
  const config: NodeV2Config = { ...defaults };
  if (!value || typeof value !== "object" || Array.isArray(value)) return config;
  const incoming = value as Record<string, unknown>;
  if (typeof incoming.workspacePath === "string") config.workspacePath = incoming.workspacePath;
  if (typeof incoming.taskPrompt === "string") config.taskPrompt = incoming.taskPrompt;
  if (typeof incoming.content === "string") config.content = incoming.content;
  return config;
}

function toDurableNode(node: NodeV2): NodeV2 {
  const definition = getNodeDefinition(node.type);
  return {
    ...node,
    config: sanitizeConfig(node.config, definition?.defaultConfig ?? {}),
    status: "idle",
    output: null,
  };
}

export function workspaceStateSnapshot(): WorkspaceStateV2 {
  return {
    version: 2,
    nodes: serializeNodes().map(toDurableNode),
    edges: serializeEdges(),
    planElements: planExcalidrawData,
    chatMessages: serializeChatMessages(),
  };
}

function persistedWorkspaceStateSnapshot(): WorkspaceStateV2 & { savedAt: string } {
  return {
    ...workspaceStateSnapshot(),
    savedAt: new Date().toISOString(),
  };
}

function isValidNodeV2Type(type: unknown): type is NodeV2Type {
  return typeof type === "string" && getNodeDefinition(type) !== null;
}

function isValidEdgeKind(kind: unknown): kind is EdgeV2Kind {
  return kind === "flow" || kind === "midput" || kind === "reject";
}

function normalizeHydratedNode(value: unknown): NodeV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const node = value as Partial<NodeV2>;
  const { id, type, title, x, y, width, height, createdBy, createdAt, updatedAt } = node;
  if (
    typeof id !== "string" ||
    !isValidNodeV2Type(type) ||
    typeof title !== "string" ||
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    typeof createdBy !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt)
  ) {
    return null;
  }

  const definition = getNodeDefinition(type);
  return {
    id,
    type,
    title,
    x,
    y,
    width,
    height,
    config: sanitizeConfig(node.config, definition?.defaultConfig ?? {}),
    status: "idle",
    output: null,
    createdBy,
    createdAt,
    updatedAt,
  };
}

function normalizeHydratedEdge(value: unknown): EdgeV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const edge = value as Partial<EdgeV2>;
  const { id, sourceId, targetId, kind, createdBy, createdAt } = edge;
  if (
    typeof id !== "string" ||
    typeof sourceId !== "string" ||
    typeof targetId !== "string" ||
    !isValidEdgeKind(kind) ||
    typeof createdBy !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }

  return {
    id,
    sourceId,
    targetId,
    kind,
    createdBy,
    createdAt,
  };
}

function normalizeHydratedChatMessage(value: unknown): ChatTranscriptMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Partial<ChatTranscriptMessage>;
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant") ||
    typeof message.content !== "string" ||
    typeof message.createdAt !== "number" ||
    !Number.isFinite(message.createdAt)
  ) {
    return null;
  }

  const content = message.content.trim();
  if (!content) return null;
  return {
    id: message.id,
    role: message.role,
    content: content.slice(0, 8000),
    createdAt: message.createdAt,
  };
}

function quarantineWorkspaceState(reason: string): void {
  const filePath = workspaceStateFile();
  if (!existsSync(filePath)) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const basename = path.basename(filePath, ".json");
    renameSync(filePath, path.join(workspaceStateDir(), `${basename}.${reason}.${stamp}.json`));
  } catch (err) {
    console.warn("[workspace-state] failed to quarantine", err);
  }
}

export function hydrateWorkspaceState(): boolean {
  const filePath = workspaceStateFile();
  if (!existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<WorkspaceStateV2>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 2) {
      quarantineWorkspaceState("unsupported");
      return false;
    }

    const nextNodes = new Map<string, NodeV2>();
    const nextEdges = new Map<string, EdgeV2>();
    const nextChatMessages: ChatTranscriptMessage[] = [];

    let seenInitialiser = false;
    for (const rawNode of Array.isArray(parsed.nodes) ? parsed.nodes : []) {
      const node = normalizeHydratedNode(rawNode);
      if (!node) continue;
      if (node.type === "initialiser") {
        if (seenInitialiser) continue;
        seenInitialiser = true;
      }
      nextNodes.set(node.id, node);
    }

    for (const rawEdge of Array.isArray(parsed.edges) ? parsed.edges : []) {
      const edge = normalizeHydratedEdge(rawEdge);
      if (!edge) continue;
      if (!nextNodes.has(edge.sourceId) || !nextNodes.has(edge.targetId)) continue;
      nextEdges.set(edge.id, edge);
    }

    for (const rawMessage of Array.isArray(parsed.chatMessages) ? parsed.chatMessages : []) {
      const message = normalizeHydratedChatMessage(rawMessage);
      if (message) nextChatMessages.push(message);
    }

    const nextPlanElements = normalizePlanElements(parsed.planElements) ?? DEFAULT_PLAN_ELEMENTS;
    nodes.clear();
    edges.clear();
    for (const [id, node] of nextNodes) nodes.set(id, node);
    for (const [id, edge] of nextEdges) edges.set(id, edge);
    chatTranscript = nextChatMessages.slice(-MAX_CHAT_TRANSCRIPT_MESSAGES);
    planExcalidrawData = nextPlanElements;
    return true;
  } catch (err) {
    console.warn("[workspace-state] failed to load", err);
    quarantineWorkspaceState("corrupt");
    return false;
  }
}

export function persistWorkspaceState(): boolean {
  if (persistenceSuspended) return false;
  const filePath = workspaceStateFile();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(workspaceStateDir(), { recursive: true });
    if (existsSync(filePath)) copyFileSync(filePath, `${filePath}.bak`);
    writeFileSync(tmpPath, `${JSON.stringify(persistedWorkspaceStateSnapshot(), null, 2)}\n`, "utf-8");
    renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.warn("[workspace-state] failed to save", err);
    return false;
  }
}

export function appendChatMessage(role: ChatTranscriptMessage["role"], content: string): ChatTranscriptMessage | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const message: ChatTranscriptMessage = {
    id: createId("chat"),
    role,
    content: trimmed.slice(0, 8000),
    createdAt: Date.now(),
  };
  chatTranscript = [...chatTranscript, message].slice(-MAX_CHAT_TRANSCRIPT_MESSAGES);
  persistWorkspaceState();
  return message;
}

export function setWorkspaceStateFileForTests(filePath: string | null): void {
  workspaceStateFileOverride = filePath;
  persistenceSuspended = filePath === null;
}

export function resetWorkspaceForTests(): void {
  nodes.clear();
  edges.clear();
  chatTranscript = [];
  planExcalidrawData = DEFAULT_PLAN_ELEMENTS;
  workspaceStateFileOverride = null;
  persistenceSuspended = true;
}

export function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export function broadcast(message: unknown, exceptWs: WebSocket | null = null): void {
  const encoded = JSON.stringify(message);
  for (const ws of clients.keys()) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(encoded);
  }
}

export function safeWorkspaceTab(value: unknown): WorkspaceTab {
  return value === "plan" ? "plan" : "canvas";
}

// hydrateWorkspaceState(); // TEMP: persistence disabled
