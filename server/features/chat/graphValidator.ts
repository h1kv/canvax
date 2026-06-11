import type { EdgeV2, NodeV2 } from "../../../shared/types.js";
import { SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";

export interface ValidationIssue {
  kind: "error" | "warn";
  message: string;
  nodeId?: string;
}

export function validateGraph(
  nodes: Map<string, NodeV2>,
  edges: Map<string, EdgeV2>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const initialisers = Array.from(nodes.values()).filter((n) => n.type === "initialiser");

  if (initialisers.length === 0) {
    issues.push({ kind: "error", message: "No Initialiser node. Add one to start a chain." });
    return issues;
  }
  if (initialisers.length > 1) {
    issues.push({ kind: "error", message: "Multiple Initialiser nodes. Only one is allowed." });
  }

  const init = initialisers[0];

  function flowFrom(id: string) {
    return Array.from(edges.values()).filter((e) => e.sourceId === id && e.kind === "flow");
  }
  function flowTo(id: string) {
    return Array.from(edges.values()).filter((e) => e.targetId === id && e.kind === "flow");
  }

  if (flowFrom(init.id).length === 0) {
    issues.push({ kind: "error", message: "Initialiser has no flow output. Connect it to the first node.", nodeId: init.id });
  }
  if (!init.config?.workspacePath?.trim()) {
    issues.push({ kind: "warn", message: "Initialiser has no workspace path.", nodeId: init.id });
  }

  for (const node of nodes.values()) {
    if (!SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number])) continue;
    if (flowTo(node.id).length === 0) {
      issues.push({ kind: "warn", message: `"${node.title}" (${node.type}) has no flow input — won't run.`, nodeId: node.id });
    }
    if (!node.config?.taskPrompt?.trim()) {
      issues.push({ kind: "warn", message: `"${node.title}" (${node.type}) has no task prompt.`, nodeId: node.id });
    }
  }

  for (const edge of edges.values()) {
    const src = nodes.get(edge.sourceId);
    if (src?.type === "context" && edge.kind === "flow") {
      issues.push({ kind: "error", message: `"${src.title}" (Context) must use midput edges, not flow.`, nodeId: src.id });
    }
  }

  for (const node of nodes.values()) {
    if (node.type === "apply" && flowTo(node.id).length === 0) {
      issues.push({ kind: "warn", message: `"${node.title}" (Apply) has no flow input.`, nodeId: node.id });
    }
  }

  // Cycle detection (DFS)
  const visited = new Set<string>();
  const stack = new Set<string>();
  let cycleFound = false;
  function dfs(id: string): void {
    if (cycleFound || stack.has(id)) { cycleFound = true; return; }
    if (visited.has(id)) return;
    visited.add(id); stack.add(id);
    for (const e of edges.values()) {
      if (e.sourceId === id && (e.kind === "flow" || e.kind === "reject")) dfs(e.targetId);
    }
    stack.delete(id);
  }
  for (const id of nodes.keys()) dfs(id);
  if (cycleFound) issues.push({ kind: "error", message: "Cycle detected in workflow. Cycles are not supported." });

  return issues;
}
