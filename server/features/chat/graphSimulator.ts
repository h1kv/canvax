import type { ChatGraphOperation, EdgeV2, NodeV2 } from "../../../shared/types.js";
import { getNodeDefinition, GRID_SIZE, INITIALISER_NODE_TYPE } from "../../../shared/nodeRegistry.js";
export type { ChatGraphOperation };

function snap(v: number): number { return Math.round(v / GRID_SIZE) * GRID_SIZE; }

export interface SimResult {
  nodes: Map<string, NodeV2>;
  edges: Map<string, EdgeV2>;
  tempIdMap: Map<string, string>;
  errors: string[];
}

export function simulateOperations(
  sourceNodes: Map<string, NodeV2>,
  sourceEdges: Map<string, EdgeV2>,
  operations: ChatGraphOperation[]
): SimResult {
  const simNodes = new Map(sourceNodes);
  const simEdges = new Map(sourceEdges);
  const tempIdMap = new Map<string, string>();
  const errors: string[] = [];
  let counter = Date.now();

  function resolveId(id: string): string {
    return tempIdMap.get(id) ?? id;
  }

  function findEdgeId(sourceId: string, targetId: string, kind?: string): string | null {
    const realSourceId = resolveId(sourceId);
    const realTargetId = resolveId(targetId);
    for (const [edgeId, edge] of simEdges) {
      if (
        edge.sourceId === realSourceId &&
        edge.targetId === realTargetId &&
        (!kind || edge.kind === kind)
      ) {
        return edgeId;
      }
    }
    return null;
  }

  function resolveEdgeId(edgeId: string, sourceId?: string, targetId?: string, kind?: string): string | null {
    const realId = resolveId(edgeId);
    if (simEdges.has(realId)) return realId;
    for (const [candidateId, edge] of simEdges) {
      const syntheticIds = [
        `${edge.sourceId}-${edge.targetId}`,
        `${edge.sourceId}->${edge.targetId}`,
        `${edge.sourceId}:${edge.targetId}`,
        `${edge.sourceId}:${edge.targetId}:${edge.kind}`,
      ];
      if (syntheticIds.includes(edgeId) && (!kind || edge.kind === kind)) return candidateId;
    }
    if (sourceId && targetId) return findEdgeId(sourceId, targetId, kind);
    return null;
  }

  for (const op of operations) {
    if (op.op === "create_node") {
      const def = getNodeDefinition(op.nodeType);
      if (!def) { errors.push(`Unknown node type: "${op.nodeType}"`); continue; }
      if (op.nodeType === INITIALISER_NODE_TYPE && Array.from(simNodes.values()).some((n) => n.type === INITIALISER_NODE_TYPE)) {
        errors.push("Cannot create a second Initialiser"); continue;
      }
      const realId = `chat-${counter++}`;
      tempIdMap.set(op.tempId, realId);
      const pos = op.position ?? { x: 400, y: 200 };
      simNodes.set(realId, {
        id: realId,
        type: op.nodeType,
        title: op.title ?? def.defaultTitle,
        x: snap(pos.x),
        y: snap(pos.y),
        width: def.width,
        height: def.height,
        config: { ...def.defaultConfig, ...(op.config ?? {}) },
        status: "idle",
        output: null,
        createdBy: "chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    else if (op.op === "update_node") {
      const realId = resolveId(op.nodeId);
      const node = simNodes.get(realId);
      if (!node) { errors.push(`Node not found: "${op.nodeId}"`); continue; }
      simNodes.set(realId, {
        ...node,
        title: op.title !== undefined ? op.title : node.title,
        config: op.config ? { ...node.config, ...op.config } : node.config,
        updatedAt: Date.now(),
      });
    }

    else if (op.op === "delete_node") {
      const realId = resolveId(op.nodeId);
      if (!simNodes.has(realId)) { errors.push(`Node not found: "${op.nodeId}"`); continue; }
      simNodes.delete(realId);
      for (const [eid, edge] of simEdges) {
        if (edge.sourceId === realId || edge.targetId === realId) simEdges.delete(eid);
      }
    }

    else if (op.op === "create_edge") {
      const realSourceId = resolveId(op.sourceId);
      const realTargetId = resolveId(op.targetId);
      const srcNode = simNodes.get(realSourceId);
      const tgtNode = simNodes.get(realTargetId);
      if (!srcNode) { errors.push(`Edge source not found: "${op.sourceId}"`); continue; }
      if (!tgtNode) { errors.push(`Edge target not found: "${op.targetId}"`); continue; }
      const srcDef = getNodeDefinition(srcNode.type);
      const tgtDef = getNodeDefinition(tgtNode.type);
      if (!srcDef || !tgtDef) continue;
      if (op.kind === "flow" && (!srcDef.hasFlowOut || !tgtDef.hasFlowIn)) {
        errors.push(`${srcNode.type} → ${tgtNode.type} via flow: capability mismatch`); continue;
      }
      if (op.kind === "midput" && (!srcDef.hasMidputOut || !tgtDef.hasMidputIn)) {
        errors.push(`${srcNode.type} → ${tgtNode.type} via midput: capability mismatch`); continue;
      }
      if (op.kind === "reject" && (!srcDef.hasRejectOut || !tgtDef.hasFlowIn)) {
        errors.push(`${srcNode.type} → ${tgtNode.type} via reject: capability mismatch`); continue;
      }
      const realId = `chat-e${counter++}`;
      tempIdMap.set(op.tempId, realId);
      simEdges.set(realId, {
        id: realId,
        sourceId: realSourceId,
        targetId: realTargetId,
        kind: op.kind,
        createdBy: "chat",
        createdAt: Date.now(),
      });
    }

    else if (op.op === "delete_edge") {
      const realId = resolveEdgeId(op.edgeId, op.sourceId, op.targetId, op.kind);
      if (!realId) { errors.push(`Edge not found: "${op.edgeId}"`); continue; }
      simEdges.delete(realId);
    }

    else if (op.op === "delete_edge_between") {
      const realId = findEdgeId(op.sourceId, op.targetId, op.kind);
      if (!realId) { errors.push(`Edge not found between "${op.sourceId}" and "${op.targetId}"`); continue; }
      simEdges.delete(realId);
    }

    else if (op.op === "insert_node_between") {
      const existingEdgeId = findEdgeId(op.sourceId, op.targetId, op.kind ?? "flow");
      if (!existingEdgeId) {
        errors.push(`Edge not found between "${op.sourceId}" and "${op.targetId}"`);
        continue;
      }

      const existingEdge = simEdges.get(existingEdgeId)!;
      const def = getNodeDefinition(op.nodeType);
      if (!def) { errors.push(`Unknown node type: "${op.nodeType}"`); continue; }
      if (op.nodeType === INITIALISER_NODE_TYPE && Array.from(simNodes.values()).some((n) => n.type === INITIALISER_NODE_TYPE)) {
        errors.push("Cannot create a second Initialiser"); continue;
      }

      simEdges.delete(existingEdgeId);
      const realId = `chat-${counter++}`;
      tempIdMap.set(op.tempId, realId);
      const sourceNode = simNodes.get(existingEdge.sourceId);
      const targetNode = simNodes.get(existingEdge.targetId);
      const pos = {
        x: sourceNode?.x ?? targetNode?.x ?? 400,
        y: sourceNode && targetNode
          ? sourceNode.y + sourceNode.height + Math.max(24, (targetNode.y - (sourceNode.y + sourceNode.height)) / 2)
          : 200,
      };
      simNodes.set(realId, {
        id: realId,
        type: op.nodeType,
        title: op.title ?? def.defaultTitle,
        x: snap(pos.x),
        y: snap(pos.y),
        width: def.width,
        height: def.height,
        config: { ...def.defaultConfig, ...(op.config ?? {}) },
        status: "idle",
        output: null,
        createdBy: "chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const incomingEdgeId = `chat-e${counter++}`;
      simEdges.set(incomingEdgeId, {
        id: incomingEdgeId,
        sourceId: existingEdge.sourceId,
        targetId: realId,
        kind: existingEdge.kind,
        createdBy: "chat",
        createdAt: Date.now(),
      });
      const outgoingEdgeId = `chat-e${counter++}`;
      simEdges.set(outgoingEdgeId, {
        id: outgoingEdgeId,
        sourceId: realId,
        targetId: existingEdge.targetId,
        kind: existingEdge.kind === "reject" ? "flow" : existingEdge.kind,
        createdBy: "chat",
        createdAt: Date.now(),
      });
    }
  }

  return { nodes: simNodes, edges: simEdges, tempIdMap, errors };
}
