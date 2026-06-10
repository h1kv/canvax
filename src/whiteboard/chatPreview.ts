import { GRID_SIZE, NODE_REGISTRY } from "../../shared/nodeRegistry.js";
import type { ChatGraphOperation, EdgeV2, NodeV2, NodeV2Type } from "../types/index.js";
import type { GraphPreviewState } from "./render.js";

const VERTICAL_GAP = 40;
const CONTEXT_X_OFFSET = -288;

function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

function computePreviewLayout(
  existingNodes: Map<string, NodeV2>,
  newNodes: Array<{ tempId: string; nodeType: NodeV2Type }>,
  newEdges: Array<{ sourceId: string; targetId: string; kind: string }>
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  let anchorX = 400;
  let anchorY = 200;
  if (existingNodes.size > 0) {
    let maxBottom = -Infinity;
    for (const node of existingNodes.values()) {
      const bottom = node.y + node.height;
      if (bottom > maxBottom) {
        maxBottom = bottom;
        anchorX = node.x;
        anchorY = maxBottom + VERTICAL_GAP;
      }
    }
  }

  const existingIds = new Set(existingNodes.keys());
  const newNodeMap = new Map(newNodes.map((node) => [node.tempId, node]));
  const newTempIds = new Set(newNodes.map((node) => node.tempId));
  const flowSucc = new Map<string, string>();
  const flowPred = new Map<string, string>();
  const midputTargets = new Map<string, string>();

  for (const edge of newEdges) {
    if (edge.kind === "flow") {
      flowSucc.set(edge.sourceId, edge.targetId);
      flowPred.set(edge.targetId, edge.sourceId);
    }
    if (edge.kind === "midput") {
      midputTargets.set(edge.sourceId, edge.targetId);
    }
  }

  const contextTempIds = new Set(newNodes.filter((node) => node.nodeType === "context").map((node) => node.tempId));
  const chainTempIds = newNodes.filter((node) => node.nodeType !== "context").map((node) => node.tempId);
  const chainOrder: string[] = [];
  const visited = new Set<string>();

  function walkChain(id: string): void {
    if (!newTempIds.has(id) || contextTempIds.has(id) || visited.has(id)) return;
    visited.add(id);
    chainOrder.push(id);
    const next = flowSucc.get(id);
    if (next) walkChain(next);
  }

  for (const tempId of chainTempIds) {
    const pred = flowPred.get(tempId);
    if (!pred || existingIds.has(pred)) walkChain(tempId);
  }
  for (const tempId of chainTempIds) {
    if (!visited.has(tempId)) walkChain(tempId);
  }

  let y = snap(anchorY);
  for (const tempId of chainOrder) {
    const spec = newNodeMap.get(tempId);
    const def = spec ? NODE_REGISTRY[spec.nodeType] : null;
    positions.set(tempId, { x: snap(anchorX), y });
    y = snap(y + (def?.height ?? 104) + VERTICAL_GAP);
  }

  const contextDef = NODE_REGISTRY.context;
  for (const tempId of contextTempIds) {
    const targetTempId = midputTargets.get(tempId);
    const targetPos = targetTempId ? positions.get(targetTempId) : null;
    const targetSpec = targetTempId ? newNodeMap.get(targetTempId) : null;
    const targetDef = targetSpec ? NODE_REGISTRY[targetSpec.nodeType] : null;

    if (targetPos && targetDef) {
      const targetMidY = targetPos.y + targetDef.height / 2;
      positions.set(tempId, {
        x: snap(targetPos.x + CONTEXT_X_OFFSET),
        y: snap(targetMidY - contextDef.height / 2),
      });
    } else {
      positions.set(tempId, { x: snap(anchorX + CONTEXT_X_OFFSET), y: snap(anchorY) });
    }
  }

  return positions;
}

export function buildChatGraphPreview(
  operations: ChatGraphOperation[] | null,
  existingNodes: Map<string, NodeV2>,
  existingEdges: Map<string, EdgeV2>
): GraphPreviewState | null {
  if (!operations?.length) return null;

  const createNodeOps = operations.filter(
    (op): op is Extract<ChatGraphOperation, { op: "create_node" }> => op.op === "create_node"
  );
  const createEdgeOps = operations.filter(
    (op): op is Extract<ChatGraphOperation, { op: "create_edge" }> => op.op === "create_edge"
  );
  const layoutPositions = computePreviewLayout(
    existingNodes,
    createNodeOps.map((op) => ({ tempId: op.tempId, nodeType: op.nodeType })),
    createEdgeOps.map((op) => ({ sourceId: op.sourceId, targetId: op.targetId, kind: op.kind }))
  );

  const previewNodes: NodeV2[] = [];
  const previewEdges: EdgeV2[] = [];
  const tempIdToPreviewId = new Map<string, string>();
  const previewLookup = new Map(existingNodes);

  function resolveId(id: string): string {
    return tempIdToPreviewId.get(id) ?? id;
  }

  for (const op of operations) {
    if (op.op === "create_node") {
      const def = NODE_REGISTRY[op.nodeType];
      if (!def) continue;
      const id = `preview-${op.tempId}`;
      tempIdToPreviewId.set(op.tempId, id);
      const pos = layoutPositions.get(op.tempId) ?? op.position ?? { x: 400, y: 200 };
      const node: NodeV2 = {
        id,
        type: op.nodeType,
        title: op.title ?? def.defaultTitle,
        x: snap(pos.x),
        y: snap(pos.y),
        width: def.width,
        height: def.height,
        config: { ...def.defaultConfig, ...(op.config ?? {}) },
        status: "idle",
        output: null,
        createdBy: "chat-preview",
        createdAt: 0,
        updatedAt: 0,
      };
      previewNodes.push(node);
      previewLookup.set(id, node);
    } else if (op.op === "update_node") {
      const existing = existingNodes.get(op.nodeId);
      if (!existing) continue;
      const node: NodeV2 = {
        ...existing,
        title: op.title ?? existing.title,
        config: op.config ? { ...existing.config, ...op.config } : existing.config,
        updatedAt: Date.now(),
      };
      previewNodes.push(node);
      previewLookup.set(node.id, node);
    } else if (op.op === "delete_node") {
      previewLookup.delete(op.nodeId);
    } else if (op.op === "create_edge") {
      const sourceId = resolveId(op.sourceId);
      const targetId = resolveId(op.targetId);
      if (!previewLookup.has(sourceId) || !previewLookup.has(targetId)) continue;
      previewEdges.push({
        id: `preview-${op.tempId}`,
        sourceId,
        targetId,
        kind: op.kind,
        createdBy: "chat-preview",
        createdAt: 0,
      });
    } else if (op.op === "delete_edge") {
      const existing = existingEdges.get(op.edgeId);
      if (!existing) continue;
    }
  }

  if (previewNodes.length === 0 && previewEdges.length === 0) return null;
  return { nodes: previewNodes, edges: previewEdges };
}
