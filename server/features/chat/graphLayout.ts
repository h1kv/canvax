import type { NodeV2, NodeV2Type } from "../../../shared/types.js";
import { NODE_REGISTRY, GRID_SIZE } from "../../../shared/nodeRegistry.js";

const VERTICAL_GAP = 40;
const CONTEXT_X_OFFSET = -288;

function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

export interface NewNodeSpec {
  tempId: string;
  nodeType: NodeV2Type;
}

export interface NewEdgeSpec {
  sourceId: string;
  targetId: string;
  kind: string;
}

export function computeLayoutForBatch(
  existingNodes: Map<string, NodeV2>,
  newNodes: NewNodeSpec[],
  newEdges: NewEdgeSpec[]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Find chain anchor: bottom of existing graph, or default
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
  const newNodeMap = new Map(newNodes.map((n) => [n.tempId, n]));
  const newTempIds = new Set(newNodes.map((n) => n.tempId));

  // Build flow adjacency within new nodes
  const flowSucc = new Map<string, string>();
  const flowPred = new Map<string, string>();
  const midputTargets = new Map<string, string>(); // context tempId → target tempId

  for (const edge of newEdges) {
    if (edge.kind === "flow") {
      flowSucc.set(edge.sourceId, edge.targetId);
      flowPred.set(edge.targetId, edge.sourceId);
    }
    if (edge.kind === "midput") {
      midputTargets.set(edge.sourceId, edge.targetId);
    }
  }

  // Separate context nodes from chain nodes
  const contextTempIds = new Set(newNodes.filter((n) => n.nodeType === "context").map((n) => n.tempId));
  const chainTempIds = newNodes.filter((n) => n.nodeType !== "context").map((n) => n.tempId);

  // Topological order: find chain roots (no new-node predecessor, or predecessor is existing)
  const chainOrder: string[] = [];
  const visited = new Set<string>();

  function walkChain(id: string): void {
    if (!newTempIds.has(id) || contextTempIds.has(id) || visited.has(id)) return;
    visited.add(id);
    chainOrder.push(id);
    const next = flowSucc.get(id);
    if (next) walkChain(next);
  }

  // Start from nodes whose predecessor is either absent or in existingNodes
  for (const tempId of chainTempIds) {
    const pred = flowPred.get(tempId);
    if (!pred || existingIds.has(pred)) walkChain(tempId);
  }
  // Remaining stragglers (islands with no edges)
  for (const tempId of chainTempIds) {
    if (!visited.has(tempId)) walkChain(tempId);
  }

  // Assign chain node positions vertically
  let y = snap(anchorY);
  for (const tempId of chainOrder) {
    const spec = newNodeMap.get(tempId);
    const def = spec ? NODE_REGISTRY[spec.nodeType] : null;
    positions.set(tempId, { x: snap(anchorX), y });
    y = snap(y + (def?.height ?? 104) + VERTICAL_GAP);
  }

  // Assign context node positions: left of their midput target
  const contextDef = NODE_REGISTRY["context"];
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
      // No target found — stack near the chain start
      positions.set(tempId, { x: snap(anchorX + CONTEXT_X_OFFSET), y: snap(anchorY) });
    }
  }

  return positions;
}
