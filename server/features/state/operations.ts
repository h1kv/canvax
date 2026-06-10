import { getNodeDefinition, GRID_SIZE, INITIALISER_NODE_TYPE } from "../../../shared/nodeRegistry.js";
import type { EdgeV2, EdgeV2Kind, NodeV2, NodeV2Config, NodeV2Type, Point } from "../../../shared/types.js";
import { createId } from "../../utils/id.js";
import { safeLabel, safeText, snapPoint } from "../../utils/validation.js";
import { edges, nodes, persistWorkspaceState } from "./store.js";

export interface CreateNodeV2Params {
  nodeId?: string;
  type: unknown;
  position: Point | null;
  title?: unknown;
  config?: unknown;
  userId: string;
}

export interface UpdateNodeV2Patch {
  position?: Point | null;
  title?: unknown;
  config?: Partial<NodeV2Config>;
  status?: NodeV2["status"];
  output?: string | null;
}

export interface CreateEdgeParams {
  edgeId?: string;
  sourceId: string;
  targetId: string;
  kind: unknown;
  userId: string;
}

function hasInitialiser(): boolean {
  return Array.from(nodes.values()).some((node) => node.type === INITIALISER_NODE_TYPE);
}

function safeNodeType(value: unknown): NodeV2Type | null {
  return typeof value === "string" && getNodeDefinition(value) ? value as NodeV2Type : null;
}

function safeConfig(value: unknown, defaults: NodeV2Config): NodeV2Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
  const incoming = value as Record<string, unknown>;
  const result: NodeV2Config = { ...defaults };
  if (typeof incoming.workspacePath === "string") result.workspacePath = incoming.workspacePath;
  if (typeof incoming.taskPrompt === "string") result.taskPrompt = incoming.taskPrompt;
  if (typeof incoming.content === "string") result.content = incoming.content;
  return result;
}

function patchTouchesDurableNodeState(patch: UpdateNodeV2Patch): boolean {
  return Boolean(
    patch.position ||
    typeof patch.title === "string" ||
    (patch.config && typeof patch.config === "object")
  );
}

export function createNodeFromPayload(params: CreateNodeV2Params): NodeV2 | null {
  const type = safeNodeType(params.type);
  const definition = type ? getNodeDefinition(type) : null;
  if (!type || !definition || !params.position) return null;
  if (type === INITIALISER_NODE_TYPE && hasInitialiser()) return null;

  const snapped = snapPoint(params.position, GRID_SIZE);
  const now = Date.now();
  const node: NodeV2 = {
    id: safeText(params.nodeId, createId("node")),
    type,
    title: safeLabel(params.title, definition.defaultTitle),
    x: snapped.x,
    y: snapped.y,
    width: definition.width,
    height: definition.height,
    config: safeConfig(params.config, definition.defaultConfig),
    status: "idle",
    output: null,
    createdBy: params.userId,
    createdAt: now,
    updatedAt: now,
  };
  nodes.set(node.id, node);
  persistWorkspaceState();
  return node;
}

export function updateNode(nodeId: string, patch: UpdateNodeV2Patch): NodeV2 | null {
  const node = nodes.get(nodeId);
  if (!node) return null;

  const next: NodeV2 = { ...node, updatedAt: Date.now() };
  if (patch.position) {
    const snapped = snapPoint(patch.position, GRID_SIZE);
    next.x = snapped.x;
    next.y = snapped.y;
  }
  if (typeof patch.title === "string") {
    next.title = safeLabel(patch.title, node.title);
  }
  if (patch.config && typeof patch.config === "object") {
    next.config = { ...node.config, ...patch.config };
  }
  if (patch.status !== undefined) {
    next.status = patch.status;
  }
  if (patch.output !== undefined) {
    next.output = patch.output;
  }

  nodes.set(nodeId, next);
  if (patchTouchesDurableNodeState(patch)) persistWorkspaceState();
  return next;
}

export function deleteNode(nodeId: string): boolean {
  const deleted = nodes.delete(nodeId);
  if (!deleted) return false;

  for (const [edgeId, edge] of edges) {
    if (edge.sourceId === nodeId || edge.targetId === nodeId) {
      edges.delete(edgeId);
    }
  }

  persistWorkspaceState();
  return true;
}

export function createEdge(params: CreateEdgeParams): EdgeV2 | null {
  const { sourceId, targetId, userId } = params;
  if (!nodes.has(sourceId) || !nodes.has(targetId)) return null;
  if (sourceId === targetId) return null;

  const kind = (params.kind === "flow" || params.kind === "midput" || params.kind === "reject")
    ? params.kind as EdgeV2Kind
    : null;
  if (!kind) return null;

  const sourceNode = nodes.get(sourceId)!;
  const targetNode = nodes.get(targetId)!;
  const sourceDef = getNodeDefinition(sourceNode.type);
  const targetDef = getNodeDefinition(targetNode.type);
  if (!sourceDef || !targetDef) return null;

  if (kind === "flow"   && (!sourceDef.hasFlowOut   || !targetDef.hasFlowIn)) return null;
  if (kind === "midput" && (!sourceDef.hasMidputOut  || !targetDef.hasMidputIn)) return null;
  if (kind === "reject" && (!sourceDef.hasRejectOut  || !targetDef.hasFlowIn)) return null;

  // prevent duplicate edge between same pair with same kind
  for (const edge of edges.values()) {
    if (edge.sourceId === sourceId && edge.targetId === targetId && edge.kind === kind) return null;
  }

  const edge: EdgeV2 = {
    id: safeText(params.edgeId, createId("edge")),
    sourceId,
    targetId,
    kind,
    createdBy: userId,
    createdAt: Date.now(),
  };

  edges.set(edge.id, edge);
  persistWorkspaceState();
  return edge;
}

export function deleteEdge(edgeId: string): boolean {
  const deleted = edges.delete(edgeId);
  if (deleted) persistWorkspaceState();
  return deleted;
}
