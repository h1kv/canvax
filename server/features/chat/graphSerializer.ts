import type { EdgeV2, NodeV2 } from "../../../shared/types.js";
import { NODE_REGISTRY } from "../../../shared/nodeRegistry.js";

export function serializeGraph(
  nodes: Map<string, NodeV2>,
  edges: Map<string, EdgeV2>,
  selectedNodeId?: string | null,
  nodeErrors?: Map<string, string>
): string {
  const lines: string[] = ["## Current Graph"];

  if (nodes.size === 0) {
    lines.push("(empty — no nodes on canvas)");
    return lines.join("\n");
  }

  lines.push(`\nNODES (${nodes.size}):`);
  for (const node of nodes.values()) {
    const def = NODE_REGISTRY[node.type];
    const label = def?.label ?? node.type;
    const status = node.status !== "idle" ? ` [${node.status}]` : "";
    const selected = node.id === selectedNodeId ? " ← SELECTED" : "";
    const parts: string[] = [`id:${node.id}`];
    if (node.config?.workspacePath) parts.push(`workspace:${node.config.workspacePath}`);
    if (node.config?.taskPrompt) {
      const t = node.config.taskPrompt;
      parts.push(`task:"${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`);
    }
    if (node.config?.content) {
      const c = node.config.content;
      parts.push(`content:"${c.slice(0, 60)}${c.length > 60 ? "…" : ""}"`);
    }
    const err = nodeErrors?.get(node.id);
    if (err) parts.push(`error:${err.slice(0, 80)}`);
    lines.push(`  [${label}] "${node.title}"${status} | ${parts.join(" ")}`);
  }

  if (edges.size > 0) {
    lines.push(`\nEDGES (${edges.size}):`);
    for (const edge of edges.values()) {
      const src = nodes.get(edge.sourceId);
      const tgt = nodes.get(edge.targetId);
      const srcLabel = src ? `"${src.title}"` : edge.sourceId;
      const tgtLabel = tgt ? `"${tgt.title}"` : edge.targetId;
      lines.push(
        `  id:${edge.id} ${srcLabel} (${edge.sourceId}) --[${edge.kind}]--> ${tgtLabel} (${edge.targetId})`
      );
    }
  }

  return lines.join("\n");
}
