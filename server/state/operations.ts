import { nodes, edges, type ServerNode, type ServerEdge } from "./store.js";
import { createId } from "../utils/id.js";
import { safeText, safeLabel, snapPoint, type Point } from "../utils/validation.js";
import { getNodeType, GRID_SIZE } from "../../src/whiteboard/config/nodeTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const AGENT_TOOL_NAMES = new Set([
  "web_search",
  "fetch_url",
  "read_file",
  "write_file",
  "list_files",
  "shell_exec",
]);

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
