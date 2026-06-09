import { nodes, edges, planNodes, planEdges, type ServerNode, type ServerEdge } from "./store.js";
import { createId } from "../utils/id.js";
import { safeText, safeLabel, snapPoint, type Point } from "../utils/validation.js";
import { getNodeType, GRID_SIZE } from "../../src/whiteboard/config/nodeTypes.js";
import type { PlanNode, PlanEdge, PlanNodeKind } from "../../src/types/index.js";

const PLAN_NODE_KINDS = new Set<PlanNodeKind>([
  "note",
  "task",
  "decision",
  "risk",
  "flow-step",
  "proposed-agent",
  "proposed-tool",
  "approval-point",
  "context",
]);

const PLAN_KIND_COLORS: Record<PlanNodeKind, string> = {
  note: "#607d8b",
  task: "#0078d4",
  decision: "#7b1fa2",
  risk: "#c07c00",
  "flow-step": "#16825d",
  "proposed-agent": "#5c6bc0",
  "proposed-tool": "#37474f",
  "approval-point": "#e65100",
  context: "#f57c00",
};

const AGENT_TOOL_NAMES = new Set([
  "web_search",
  "fetch_url",
  "read_file",
  "write_file",
  "list_files",
  "shell_exec",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAgentTools(value: unknown, defaultValue: unknown): string[] {
  const fallback = Array.isArray(defaultValue)
    ? defaultValue.filter((tool): tool is string => typeof tool === "string" && AGENT_TOOL_NAMES.has(tool))
    : ["web_search", "fetch_url"];
  if (!Array.isArray(value)) return Array.from(new Set(fallback));
  if (value.length === 0) return [];

  const filtered = value.filter((tool): tool is string =>
    typeof tool === "string" && AGENT_TOOL_NAMES.has(tool)
  );
  return filtered.length > 0 ? Array.from(new Set(filtered)) : Array.from(new Set(fallback));
}

function normalizeNodeConfig(
  typeId: string,
  defaultConfig: Record<string, unknown> | undefined,
  incomingConfig: unknown
): Record<string, unknown> {
  const defaults = defaultConfig ?? {};
  const incoming = isRecord(incomingConfig) ? incomingConfig : {};
  const next: Record<string, unknown> = { ...defaults, ...incoming };

  if (typeId === "agent") {
    next.tools = normalizeAgentTools(next.tools, defaults.tools);
    const maxToolCalls = Number(next.maxToolCalls);
    next.maxToolCalls = Number.isFinite(maxToolCalls)
      ? Math.max(0, Math.min(Math.floor(maxToolCalls), 20))
      : defaults.maxToolCalls ?? 6;
  }

  return next;
}

function safeLongText(value: unknown, fallback = "", max = 4000): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

function safePlanKind(value: unknown): PlanNodeKind {
  return typeof value === "string" && PLAN_NODE_KINDS.has(value as PlanNodeKind)
    ? value as PlanNodeKind
    : "note";
}

function isPlanKind(value: unknown): value is PlanNodeKind {
  return typeof value === "string" && PLAN_NODE_KINDS.has(value as PlanNodeKind);
}

function planHeightForKind(kind: PlanNodeKind): number {
  return kind === "note" ? 150 : 132;
}

function safeDataValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 1000);
  if (Array.isArray(value)) {
    if (depth >= 3) return undefined;
    return value
      .slice(0, 24)
      .map((item) => safeDataValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    if (depth >= 3) return undefined;
    return safeDataRecord(value, depth + 1);
  }
  return undefined;
}

function safeDataRecord(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 50)) {
    const safeKey = safeText(key, "").slice(0, 80);
    if (!safeKey) continue;
    const safeValue = safeDataValue(raw, depth);
    if (safeValue !== undefined) output[safeKey] = safeValue;
  }
  return output;
}

export interface CreateNodeParams {
  nodeId: string;
  typeId: string;
  position: Point | null;
  label: unknown;
  userId: string;
  config?: Record<string, unknown>;
}

export function createNodeFromPayload(params: CreateNodeParams): ServerNode | null {
  const { nodeId, typeId, position, label, userId } = params;
  const nodeType = getNodeType(typeId);
  if (!nodeType || !position) return null;
  const snapped = snapPoint(position, GRID_SIZE);
  const node: ServerNode = {
    id: safeText(nodeId, createId("node")),
    typeId: nodeType.id,
    label: safeLabel(label, nodeType.label),
    x: snapped.x,
    y: snapped.y,
    width: nodeType.width,
    height: nodeType.height,
    config: normalizeNodeConfig(nodeType.id, nodeType.defaultConfig, params.config),
    status: "idle",
    output: null,
    createdBy: userId,
    createdAt: Date.now(),
  };
  nodes.set(node.id, node);
  return node;
}

export interface UpdateNodePatch {
  position?: Point | null;
  label?: string;
}

export function updateNode(nodeId: string, patch: UpdateNodePatch): ServerNode | null {
  const node = nodes.get(nodeId);
  if (!node) return null;
  const next = { ...node };
  if (patch.position) {
    const snapped = snapPoint(patch.position, GRID_SIZE);
    next.x = snapped.x;
    next.y = snapped.y;
  }
  if (typeof patch.label === "string") {
    next.label = safeLabel(patch.label, node.label);
  }
  nodes.set(nodeId, next);
  return next;
}

export function deleteNode(nodeId: string): string[] | null {
  if (!nodes.delete(nodeId)) return null;
  const removedEdgeIds: string[] = [];
  for (const [edgeId, edge] of edges.entries()) {
    if (edge.sourceId === nodeId || edge.targetId === nodeId) {
      edges.delete(edgeId);
      removedEdgeIds.push(edgeId);
    }
  }
  return removedEdgeIds;
}

export function updateNodeStatus(
  nodeId: string,
  status: "idle" | "running" | "done" | "error" | "paused",
  output?: string
): ServerNode | null {
  const node = nodes.get(nodeId);
  if (!node) return null;
  const next = { ...node, status, output: output ?? node.output };
  nodes.set(nodeId, next);
  return next;
}

export function updateNodeConfig(
  nodeId: string,
  config: Record<string, unknown>
): ServerNode | null {
  const node = nodes.get(nodeId);
  if (!node) return null;
  const nodeType = getNodeType(node.typeId);
  const next = {
    ...node,
    config: normalizeNodeConfig(node.typeId, nodeType?.defaultConfig, { ...node.config, ...config }),
  };
  nodes.set(nodeId, next);
  return next;
}

export function deleteEdge(edgeId: string): boolean {
  return edges.delete(edgeId);
}

export interface CreateEdgeParams { sourceId: string; targetId: string; userId: string; sourcePort?: string; }

export function createEdge(params: CreateEdgeParams): ServerEdge | null {
  const { sourceId, targetId, userId, sourcePort } = params;
  if (sourceId === targetId) return null;
  if (!nodes.has(sourceId) || !nodes.has(targetId)) return null;
  const duplicate = Array.from(edges.values()).find(
    e => (e.sourceId === sourceId && e.targetId === targetId) || (e.sourceId === targetId && e.targetId === sourceId)
  );
  if (duplicate) return null;
  const edge: ServerEdge = {
    id: createId("edge"),
    sourceId,
    targetId,
    sourcePort: sourcePort ?? "default",
    createdBy: userId,
    createdAt: Date.now(),
  };
  edges.set(edge.id, edge);
  return edge;
}

export interface CreatePlanNodeParams {
  nodeId?: string;
  kind: unknown;
  title: unknown;
  body: unknown;
  position: Point | null;
  userId: string;
  data?: Record<string, unknown>;
}

export function createPlanNodeFromPayload(params: CreatePlanNodeParams): PlanNode | null {
  if (!params.position) return null;
  const kind = safePlanKind(params.kind);
  const snapped = snapPoint(params.position, GRID_SIZE);
  const id = safeText(params.nodeId, createId("plan"));
  if (planNodes.has(id)) return null;
  const node: PlanNode = {
    id,
    kind,
    title: safeLongText(params.title, kind.replace("-", " "), 120) || kind.replace("-", " "),
    body: safeLongText(params.body),
    x: snapped.x,
    y: snapped.y,
    width: 260,
    height: planHeightForKind(kind),
    color: PLAN_KIND_COLORS[kind],
    createdBy: params.userId,
    createdAt: Date.now(),
    data: safeDataRecord(params.data),
  };
  planNodes.set(node.id, node);
  return node;
}

export interface UpdatePlanNodePatch {
  position?: Point | null;
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  data?: Record<string, unknown>;
}

export function updatePlanNode(nodeId: string, patch: UpdatePlanNodePatch): PlanNode | null {
  const node = planNodes.get(nodeId);
  if (!node) return null;
  const next: PlanNode = { ...node };
  let changed = false;
  if (patch.position) {
    const snapped = snapPoint(patch.position, GRID_SIZE);
    next.x = snapped.x;
    next.y = snapped.y;
    changed = true;
  }
  if (isPlanKind(patch.kind)) {
    next.kind = patch.kind;
    next.color = PLAN_KIND_COLORS[next.kind];
    next.height = planHeightForKind(next.kind);
    changed = true;
  }
  if (typeof patch.title === "string") {
    next.title = safeLongText(patch.title, next.title, 120) || next.title;
    changed = true;
  }
  if (typeof patch.body === "string") {
    next.body = safeLongText(patch.body, next.body, 4000);
    changed = true;
  }
  if (patch.data && typeof patch.data === "object" && !Array.isArray(patch.data)) {
    const dataPatch = safeDataRecord(patch.data);
    if (Object.keys(dataPatch).length > 0) {
      next.data = { ...next.data, ...dataPatch };
      changed = true;
    }
  }
  if (!changed) return null;
  planNodes.set(nodeId, next);
  return next;
}

export function deletePlanNode(nodeId: string): string[] | null {
  if (!planNodes.delete(nodeId)) return null;
  const removedEdgeIds: string[] = [];
  for (const [edgeId, edge] of planEdges.entries()) {
    if (edge.sourceId === nodeId || edge.targetId === nodeId) {
      planEdges.delete(edgeId);
      removedEdgeIds.push(edgeId);
    }
  }
  return removedEdgeIds;
}

export interface CreatePlanEdgeParams {
  sourceId: string;
  targetId: string;
  label?: unknown;
  userId: string;
}

export function createPlanEdge(params: CreatePlanEdgeParams): PlanEdge | null {
  const { sourceId, targetId, userId } = params;
  if (sourceId === targetId) return null;
  if (!planNodes.has(sourceId) || !planNodes.has(targetId)) return null;
  const duplicate = Array.from(planEdges.values()).find(
    e => e.sourceId === sourceId && e.targetId === targetId
  );
  if (duplicate) return null;
  const edge: PlanEdge = {
    id: createId("plan_edge"),
    sourceId,
    targetId,
    label: safeLongText(params.label, "", 80),
    createdBy: userId,
    createdAt: Date.now(),
  };
  planEdges.set(edge.id, edge);
  return edge;
}

export function deletePlanEdge(edgeId: string): boolean {
  return planEdges.delete(edgeId);
}
