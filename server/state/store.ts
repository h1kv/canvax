import type { WebSocket } from "ws";
import type { NodeRunTraceEvent, WorkspaceTab } from "../../src/types/index.js";

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
export const nodeRunTraceEvents: NodeRunTraceEvent[] = [];
export let activeRunId: string | null = null;
export let planExcalidrawData: string = '[]';

export const userColors = ["#2d2d2d", "#7c3f3f", "#4f6b45", "#7a612e", "#6a4f76", "#7a4f5b"];
export let colorIndex = 0;
export function incrementColorIndex(): void { colorIndex++; }

export function serializeUsers(): ServerUser[] { return Array.from(users.values()); }
export function serializeNodes(): ServerNode[] { return Array.from(nodes.values()); }
export function serializeEdges(): ServerEdge[] { return Array.from(edges.values()); }
export function serializeNodeRunTraceEvents(): NodeRunTraceEvent[] { return nodeRunTraceEvents.slice(-500); }

export function setPlanExcalidrawData(data: string): void { planExcalidrawData = data; }

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

export function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

export function broadcast(message: unknown, exceptWs: WebSocket | null = null): void {
  const encoded = JSON.stringify(message);
  for (const ws of clients.keys()) {
    if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(encoded);
  }
}
