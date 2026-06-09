import type { WebSocket } from "ws";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ArtifactRecord,
  EdgeKind,
  NodeRunTraceEvent,
  PlanNode,
  PlanEdge,
  RunLedger,
  WorkspaceState,
  WorkspaceTab,
} from "../../../shared/types.js";

export interface ServerUser {
  id: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  cursorWorkspace?: WorkspaceTab;
}

export interface ServerNode {
  id: string;
  typeId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  config: Record<string, unknown>;
  status: "idle" | "running" | "done" | "error" | "paused";
  output: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ServerEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourcePort: string;
  edgeKind?: EdgeKind;
  createdBy: string;
  createdAt: number;
}

export interface ApprovalResolver {
  resolve: (approved: boolean) => void;
  nodeId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export const approvalResolvers: Map<string, ApprovalResolver> = new Map();

export const clients = new Map<WebSocket, string>();
export const users = new Map<string, ServerUser>();
export const nodes = new Map<string, ServerNode>();
export const edges = new Map<string, ServerEdge>();
export const planNodes = new Map<string, PlanNode>();
export const planEdges = new Map<string, PlanEdge>();
export const nodeRunTraceEvents: NodeRunTraceEvent[] = [];
export let planExcalidrawData = "[]";
export const workspaceMemory = new Map<string, string>();
export const runHistory: RunLedger[] = [];
export const artifacts: ArtifactRecord[] = [];
export let activeRunId: string | null = null;

const WORKSPACE_STATE_DIR = path.join(process.cwd(), ".dispatch");
const WORKSPACE_STATE_FILE = path.join(WORKSPACE_STATE_DIR, "workspace-state.json");

export const userColors = ["#2d2d2d", "#7c3f3f", "#4f6b45", "#7a612e", "#6a4f76", "#7a4f5b"];
export let colorIndex = 0;
export function incrementColorIndex(): void { colorIndex++; }

export function serializeUsers(): ServerUser[] { return Array.from(users.values()); }
export function serializeNodes(): ServerNode[] { return Array.from(nodes.values()); }
export function serializeEdges(): ServerEdge[] { return Array.from(edges.values()); }
export function serializePlanNodes(): PlanNode[] { return Array.from(planNodes.values()); }
export function serializePlanEdges(): PlanEdge[] { return Array.from(planEdges.values()); }
export function serializeNodeRunTraceEvents(): NodeRunTraceEvent[] { return nodeRunTraceEvents.slice(-500); }
export function serializeWorkspaceMemory(): Record<string, string> { return Object.fromEntries(workspaceMemory); }
export function serializeRunHistory(): RunLedger[] { return runHistory.slice(-25); }
export function serializeArtifacts(): ArtifactRecord[] { return artifacts.slice(-50); }

export function setPlanExcalidrawData(data: string): void {
  planExcalidrawData = data;
  persistWorkspaceState();
}

export function upsertWorkspaceMemory(key: string, value: string): void {
  workspaceMemory.set(key, value);
  persistWorkspaceState();
}

export function appendRunHistory(ledger: RunLedger): void {
  runHistory.push(ledger);
  if (runHistory.length > 25) runHistory.splice(0, runHistory.length - 25);
  for (const artifact of ledger.artifacts) {
    artifacts.push(artifact);
  }
  if (artifacts.length > 50) artifacts.splice(0, artifacts.length - 50);
  persistWorkspaceState();
}

export function setActiveRunId(runId: string | null): void {
  activeRunId = runId;
}

export function resetNodeRunTraceEvents(): void {
  nodeRunTraceEvents.length = 0;
}

export function appendNodeRunTraceEvent(event: NodeRunTraceEvent): void {
  nodeRunTraceEvents.push(event);
  if (nodeRunTraceEvents.length > 1000) {
    nodeRunTraceEvents.splice(0, nodeRunTraceEvents.length - 1000);
  }
}

function workspaceStateSnapshot(): WorkspaceState {
  return {
    version: 1,
    nodes: serializeNodes(),
    edges: serializeEdges(),
    planElements: planExcalidrawData,
    workspaceMemory: serializeWorkspaceMemory(),
    runHistory: serializeRunHistory(),
    artifacts: serializeArtifacts(),
  };
}

function hydrateWorkspaceState(): void {
  if (!existsSync(WORKSPACE_STATE_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(WORKSPACE_STATE_FILE, "utf-8")) as Partial<WorkspaceState>;
    for (const node of parsed.nodes ?? []) nodes.set(node.id, node as ServerNode);
    for (const edge of parsed.edges ?? []) edges.set(edge.id, edge as ServerEdge);
    if (typeof parsed.planElements === "string") planExcalidrawData = parsed.planElements;
    for (const [key, value] of Object.entries(parsed.workspaceMemory ?? {})) {
      if (typeof value === "string") workspaceMemory.set(key, value);
    }
    for (const ledger of parsed.runHistory ?? []) runHistory.push(ledger);
    for (const artifact of parsed.artifacts ?? []) artifacts.push(artifact);
  } catch (err) {
    console.warn("[workspace-state] failed to load", err);
  }
}

export function persistWorkspaceState(): void {
  try {
    mkdirSync(WORKSPACE_STATE_DIR, { recursive: true });
    const tmp = `${WORKSPACE_STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(workspaceStateSnapshot(), null, 2), "utf-8");
    renameSync(tmp, WORKSPACE_STATE_FILE);
  } catch (err) {
    console.warn("[workspace-state] failed to save", err);
  }
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

hydrateWorkspaceState();
