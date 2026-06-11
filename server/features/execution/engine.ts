import { SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";
import type { EdgeV2, MaterializeWritePlan, NodeV2, ReviewRequest } from "../../../shared/types.js";
import { edges, nodes } from "../state/store.js";
import { updateNode } from "../state/operations.js";
import { orchestratorLoop } from "./orchestrator.js";

export const MAX_EVALUATE_REPAIR_ATTEMPTS = 0;

export interface RunContext {
  workspacePath: string;
  onNodeStatus: (nodeId: string, status: NodeV2["status"], output: string | null) => void;
  onLog: (level: "info" | "warn" | "error" | "done", msg: string) => void;
  onMaterializePlan: (plan: MaterializeWritePlan) => void;
  onReviewRequested: (req: ReviewRequest) => void;
  abortSignal: AbortSignal;
}

interface ChainError extends Error {
  nodeId?: string;
  needsInput?: boolean;
}

export function evaluateFailureMessage(output: string): string | null {
  if (!/^\s*(?:\*\*)?VERDICT:\s*FAIL(?:\*\*)?/im.test(output)) return null;
  return `Evaluate failed:\n${output.trim()}`;
}

export function containsFileMap(output: string): boolean {
  return /^---\s*FILE:\s*.+?\s*---\s*$/m.test(output);
}

export function canRepairEvaluationFailure(attempt: number): boolean {
  return attempt < MAX_EVALUATE_REPAIR_ATTEMPTS;
}

export function materializeContractFailureMessage(node: NodeV2, output: string): string | null {
  if (node.type !== "create") return null;
  if (!hasFlowPathToMaterialize(node.id)) return null;
  if (containsFileMap(output)) return null;
  return `Create "${node.title}" feeds Materialize but did not emit any file blocks. Materialize can only write outputs that use --- FILE: path --- delimiters.`;
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

function findInitialiser(): NodeV2 | null {
  for (const node of nodes.values()) {
    if (node.type === "initialiser") return node;
  }
  return null;
}

function edgesFrom(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.sourceId === nodeId && e.kind === kind);
}

function buildGraphGoal(initialiser: NodeV2 | null): string {
  const parts: string[] = [];
  if (initialiser?.config?.content?.trim()) parts.push(initialiser.config.content.trim());
  for (const node of nodes.values()) {
    if (SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number]) && node.config?.taskPrompt?.trim()) {
      parts.push(node.config.taskPrompt.trim());
    }
  }
  return parts.join("\n\n").trim();
}

function hasFlowPathToMaterialize(nodeId: string, visited = new Set<string>()): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);
  for (const edge of edgesFrom(nodeId, "flow")) {
    const target = nodes.get(edge.targetId);
    if (!target) continue;
    if (target.type === "apply") return true;
    if (hasFlowPathToMaterialize(target.id, visited)) return true;
  }
  return false;
}

function buildAllReachable(startId: string): NodeV2[] {
  const result: NodeV2[] = [];
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    result.push(node);
    for (const edge of edges.values()) {
      if (edge.sourceId === id && (edge.kind === "flow" || edge.kind === "reject")) {
        queue.push(edge.targetId);
      }
    }
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runChain(ctx: RunContext): Promise<void> {
  const initialiser = findInitialiser();
  if (!initialiser) throw new Error("No Initialiser node on canvas");

  const firstEdge = edgesFrom(initialiser.id, "flow")[0];
  if (!firstEdge) throw new Error("Initialiser has no connected flow output");

  const reachable = buildAllReachable(firstEdge.targetId);
  if (reachable.length === 0) throw new Error("Chain is empty");

  for (const node of reachable) {
    updateNode(node.id, { status: "idle", output: null });
    ctx.onNodeStatus(node.id, "idle", null);
  }

  const seedInput = initialiser.config?.content?.trim() ?? "";
  const goal = buildGraphGoal(initialiser);
  await orchestratorLoop(firstEdge.targetId, seedInput, goal, ctx);
}

export async function runChainFrom(fromNodeId: string, ctx: RunContext): Promise<void> {
  const reachable = buildAllReachable(fromNodeId);
  if (reachable.length === 0) throw new Error(`Node ${fromNodeId} not found`);

  for (const node of reachable) {
    updateNode(node.id, { status: "idle", output: null });
    ctx.onNodeStatus(node.id, "idle", null);
  }

  const upstreamFlowEdge = Array.from(edges.values()).find(
    (e) => e.targetId === fromNodeId && e.kind === "flow"
  );
  const upstreamNode = upstreamFlowEdge ? nodes.get(upstreamFlowEdge.sourceId) : null;

  let seedInput: string;
  if (upstreamNode?.type === "initialiser") {
    seedInput = upstreamNode.config?.content?.trim() ?? "";
  } else {
    seedInput = upstreamNode?.output ?? "";
  }

  const initialiser = findInitialiser();
  const goal = buildGraphGoal(initialiser);
  await orchestratorLoop(fromNodeId, seedInput, goal, ctx);
}
