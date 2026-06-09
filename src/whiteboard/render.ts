import type { BoardNode, BoardEdge, BoardUser, View, Point, InteractionState, NodeTypeConfig, NodeRunTraceEvent } from "../types/index.js";
import { clamp, worldToScreen } from "./geometry.js";
import { getNodeTypeMap } from "./config/nodeTypes.js";

const HEADER_H = 28;
const PORT_RADIUS = 5;

const ROLE_COLORS: Record<string, string> = {
  investigate: "#1565c0",
  plan:        "#2e7d32",
  design:      "#6a1b9a",
  create:      "#e65100",
  evaluate:    "#00838f",
  document:    "#4e342e",
  test:        "#c62828",
  debug:       "#37474f",
  refactor:    "#f9a825",
  deploy:      "#0277bd",
};

let animOffset = 0;
let pulsePhase = 0;

const STATUS_COLORS: Record<string, string> = {
  idle: "#c0c0c0",
  running: "#0078d4",
  done: "#16825d",
  error: "#e02020",
  paused: "#e65100",
  "approval-pending": "#f59e0b",
};

function drawDots(ctx: CanvasRenderingContext2D, width: number, height: number, view: View): void {
  const worldSpacing = 32;
  const dotRadius = clamp(view.scale * 1.1, 0.55, 1.25);
  const minWorldX = (0 - view.x) / view.scale;
  const minWorldY = (0 - view.y) / view.scale;
  const maxWorldX = (width - view.x) / view.scale;
  const maxWorldY = (height - view.y) / view.scale;
  const startX = Math.floor(minWorldX / worldSpacing) * worldSpacing;
  const startY = Math.floor(minWorldY / worldSpacing) * worldSpacing;

  ctx.fillStyle = "#d0d0cb";
  for (let wx = startX; wx <= maxWorldX; wx += worldSpacing) {
    for (let wy = startY; wy <= maxWorldY; wy += worldSpacing) {
      ctx.beginPath();
      ctx.arc(wx * view.scale + view.x, wy * view.scale + view.y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawCursor(ctx: CanvasRenderingContext2D, user: BoardUser, view: View): void {
  if (!user.cursor) return;
  const point = worldToScreen(user.cursor, view);
  const label = user.name || "Guest";
  const fontSize = 12;
  const paddingX = 7;
  const labelHeight = 22;
  const labelX = point.x + 10;
  const labelY = point.y + 10;

  ctx.save();
  ctx.font = `${fontSize}px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const labelWidth = Math.ceil(ctx.measureText(label).width) + paddingX * 2;

  ctx.fillStyle = user.color || "#2d2d2d";
  ctx.beginPath();
  ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 6);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, labelX + paddingX, labelY + 15);
  ctx.restore();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

function getPortX(node: BoardNode, portIndex: number, totalPorts: number): number {
  if (totalPorts <= 1) return node.x + node.width / 2;
  const padding = node.width * 0.2;
  const span = node.width - padding * 2;
  return node.x + padding + (span / (totalPorts - 1)) * portIndex;
}

export function getPortPosition(node: BoardNode, portId: string, nodeType: NodeTypeConfig | undefined): Point {
  const ports = nodeType?.outputPorts ?? [];
  if (ports.length === 0) return { x: node.x + node.width / 2, y: node.y + node.height };
  const idx = ports.findIndex((p) => p.id === portId);
  const i = idx >= 0 ? idx : 0;
  return { x: getPortX(node, i, ports.length), y: node.y + node.height };
}

// Returns the left-side context input port position for chain nodes
function getContextInputPosition(node: BoardNode): Point {
  return { x: node.x, y: node.y + node.height / 2 };
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: BoardNode,
  nodeType: NodeTypeConfig | undefined,
  selected: boolean,
  pendingConnection: boolean,
  hoverPortId: string | null,
  lastTrace: NodeRunTraceEvent | undefined,
  approvalPending: boolean
): void {
  const { x, y, width, height } = node;
  let accent = nodeType?.accent ?? "#8b8b8b";
  if (nodeType?.id === "agent") {
    const role = (node.config?.role as string) || "investigate";
    accent = ROLE_COLORS[role] ?? "#5c6bc0";
  }
  const status = node.status ?? "idle";

  ctx.save();

  const APPROVAL_COLOR = "#f59e0b";

  // Drop shadow / pulse glow
  const pulse = (Math.sin(pulsePhase) + 1) / 2;
  if (status === "running") {
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10 + pulse * 22;
    ctx.shadowOffsetY = 0;
  } else if (approvalPending) {
    ctx.shadowColor = APPROVAL_COLOR;
    ctx.shadowBlur = 8 + pulse * 18;
    ctx.shadowOffsetY = 0;
  } else {
    ctx.shadowColor = selected ? `${accent}44` : "rgba(0,0,0,0.08)";
    ctx.shadowBlur = selected ? 14 : 5;
    ctx.shadowOffsetY = 2;
  }

  // Card background
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 4);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Card border
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 4);
  if (approvalPending) {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = APPROVAL_COLOR;
    ctx.lineWidth = 2.5;
  } else if (pendingConnection) {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#0078d4";
    ctx.lineWidth = 2;
  } else if (selected) {
    ctx.setLineDash([]);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
  } else {
    ctx.setLineDash([]);
    ctx.strokeStyle = `${accent}88`;
    ctx.lineWidth = 1.5;
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Accent header band (clip to card boundary so corners are rounded)
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 4);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, width, HEADER_H);
  ctx.restore();

  // Header: type label (for agent nodes: role as primary label, "Agent" as sub-label)
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.letterSpacing = "0.06em";

  if (nodeType?.id === "agent") {
    const role = (node.config?.role as string) || "agent";
    const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
    const subLabel = node.label && node.label !== role ? node.label : "Agent";

    // Primary role label
    ctx.font = `700 11px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(roleLabel, x + 10, y + HEADER_H / 2 - 4);

    // Sub-label "Agent" (or custom node label)
    ctx.font = `400 9px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.letterSpacing = "0.04em";
    ctx.fillText(subLabel.toUpperCase(), x + 10, y + HEADER_H / 2 + 7);
    ctx.fillStyle = "#ffffff";
  } else {
    ctx.font = `600 10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    const headerLabel = (nodeType?.label ?? "Node").toUpperCase();
    ctx.fillText(headerLabel, x + 10, y + HEADER_H / 2);
  }

  ctx.letterSpacing = "0em";

  // Status dot (right of header)
  const effectiveStatusKey = approvalPending ? "approval-pending" : status;
  const dotColor = STATUS_COLORS[effectiveStatusKey] ?? STATUS_COLORS.idle;
  const dotX = x + width - 13;
  const dotY = y + HEADER_H / 2;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 5, 0, Math.PI * 2);
  ctx.fillStyle = `${accent}88`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dotX, dotY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = dotColor;
  ctx.fill();

  // Approval-pending badge
  if (approvalPending) {
    const badgeLabel = "approve?";
    ctx.font = `bold 9px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const bw = ctx.measureText(badgeLabel).width + 10;
    const bh = 14;
    const bx = x + width / 2 - bw / 2;
    const by = y + height - bh - 4;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 3);
    ctx.fillStyle = APPROVAL_COLOR;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeLabel, x + width / 2, by + bh / 2 + 0.5);
  }

  // Body: preview text
  const taskPrompt = (node.config?.taskPrompt as string) || (node.config?.systemPrompt as string) || "";
  const agentRoleHint = nodeType?.id === "agent" && !taskPrompt
    ? `Using built-in ${(node.config?.role as string) || "investigate"} skill`
    : "";
  const bodyText = taskPrompt
    || agentRoleHint
    || (node.config?.taskDescription as string)
    || (node.config?.condition as string)
    || (node.config?.notes as string)
    || (node.config?.url as string)
    || (node.config?.filePath as string)
    || (node.config?.content as string)
    || "";

  if (bodyText) {
    const bodyY = y + HEADER_H + 9;
    const maxW = width - 20;

    ctx.fillStyle = "#888888";
    ctx.font = `11px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const normalized = bodyText.replace(/\n/g, " ");
    const words = normalized.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width > maxW && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);

    const maxLines = 2;
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      const lineY = bodyY + i * 16;
      if (lineY + 14 > y + height - PORT_RADIUS - 6) break;
      const text = (i === maxLines - 1 && lines.length > maxLines)
        ? truncateText(ctx, lines[i], maxW)
        : lines[i];
      ctx.fillText(text, x + 10, lineY);
    }
  }

  if (lastTrace && nodeType?.category !== "start") {
    const traceText = traceChipText(lastTrace);
    if (traceText) {
      const chipY = y + height - 24;
      const chipH = 14;
      const maxChipW = width - 20;
      ctx.font = `10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const clipped = truncateText(ctx, traceText, maxChipW - 12);
      const chipW = Math.min(maxChipW, Math.ceil(ctx.measureText(clipped).width) + 12);
      ctx.beginPath();
      ctx.roundRect(x + 10, chipY, chipW, chipH, 3);
      ctx.fillStyle = traceChipFill(lastTrace.level);
      ctx.fill();
      ctx.strokeStyle = traceChipBorder(lastTrace.level);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = traceChipColor(lastTrace.level);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(clipped, x + 16, chipY + chipH / 2 + 0.5);
    }
  }

  // Input port (top center) — not for start or context (context is output-only)
  if (nodeType?.category !== "start" && nodeType?.category !== "context") {
    ctx.beginPath();
    ctx.arc(x + width / 2, y, PORT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = `${accent}aa`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Left-side context input port — shown on nodes that can receive context (ai-step, review, control, tool, memory)
  const contextReceivingCategories = new Set(["ai-step", "review", "control", "tool", "memory"]);
  if (nodeType && contextReceivingCategories.has(nodeType.category)) {
    const cx = x;
    const cy = y + height / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, PORT_RADIUS - 1, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#f57c0088";
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Output port(s) — always at the bottom
  const outputPorts = nodeType?.outputPorts ?? [];
  ctx.font = `10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  function drawOutputPort(px: number, py: number, portId: string, label?: string) {
    const isHovered = hoverPortId === portId;
    const r = isHovered ? PORT_RADIUS * 1.7 : PORT_RADIUS;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? accent : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = isHovered ? 2 : 1.5;
    ctx.stroke();
    if (label) {
      ctx.fillStyle = isHovered ? accent : "#888888";
      ctx.fillText(label, px, py + r + 3);
    }
  }

  if (outputPorts.length === 0) {
    drawOutputPort(x + width / 2, y + height, "default");
  } else {
    for (let i = 0; i < outputPorts.length; i++) {
      drawOutputPort(
        getPortX(node, i, outputPorts.length),
        y + height,
        outputPorts[i].id,
        outputPorts[i].label
      );
    }
  }

  ctx.restore();
}

function traceChipText(event: NodeRunTraceEvent): string {
  const toolName = typeof event.data?.toolName === "string" ? event.data.toolName : "";
  if (event.kind === "node:tool-call") return toolName ? `tool: ${toolName}` : "tool call";
  if (event.kind === "node:tool-result") return toolName ? `done: ${toolName}` : "tool done";
  if (event.kind === "node:tool-error") return toolName ? `error: ${toolName}` : "tool error";
  if (event.kind === "node:model") return "model";
  if (event.kind === "review:waiting") return "review waiting";
  if (event.kind === "review:decision") return event.message;
  if (event.kind === "node:error") return "error";
  if (event.kind === "node:output") return "output";
  return "";
}

function traceChipFill(level: NodeRunTraceEvent["level"]): string {
  if (level === "error") return "#fde7e9";
  if (level === "warn") return "#fff4ce";
  if (level === "debug") return "#f3f3f3";
  return "#eef2f5";
}

function traceChipBorder(level: NodeRunTraceEvent["level"]): string {
  if (level === "error") return "#f3b3ba";
  if (level === "warn") return "#e6c96a";
  if (level === "debug") return "#d8d8d8";
  return "#cfd8df";
}

function traceChipColor(level: NodeRunTraceEvent["level"]): string {
  if (level === "error") return "#a31515";
  if (level === "warn") return "#7a5a00";
  if (level === "debug") return "#717171";
  return "#37474f";
}

function buildLastTraceByNode(events: NodeRunTraceEvent[]): Map<string, NodeRunTraceEvent> {
  const lastByNode = new Map<string, NodeRunTraceEvent>();
  for (const event of events) {
    if (!event.nodeId) continue;
    if (!traceChipText(event)) continue;
    lastByNode.set(event.nodeId, event);
  }
  return lastByNode;
}

interface EdgeBezier {
  sp: Point;
  cp1: Point;
  cp2: Point;
  tp: Point;
  arrowAngle: number;
}

function getEdgeBezier(
  source: BoardNode,
  target: BoardNode,
  sourcePort: string,
  nodeTypeMap: Map<string, NodeTypeConfig>,
  isContextEdge = false
): EdgeBezier {
  const sourceType = nodeTypeMap.get(source.typeId);
  const sp = getPortPosition(source, sourcePort, sourceType);
  const tp: Point = { x: target.x + target.width / 2, y: target.y };

  if (isContextEdge || sourceType?.category === "context") {
    // Context exits bottom, enters LEFT-CENTER of target node
    const ctxTp: Point = getContextInputPosition(target);
    const dv = Math.abs(ctxTp.y - sp.y);
    const dh = Math.abs(ctxTp.x - sp.x);
    const tension = Math.min(200, Math.max(60, dv * 0.4 + dh * 0.3));
    const cp1: Point = { x: sp.x, y: sp.y + tension };         // exits downward
    const cp2: Point = { x: ctxTp.x - tension, y: ctxTp.y };  // enters from left
    const arrowAngle = Math.atan2(ctxTp.y - cp2.y, ctxTp.x - cp2.x);
    return { sp, cp1, cp2, tp: ctxTp, arrowAngle };
  }

  const dy = tp.y - sp.y;
  const tension = Math.min(180, Math.max(60, Math.abs(dy) * 0.5));
  const cp1: Point = { x: sp.x, y: sp.y + tension };
  const cp2: Point = { x: tp.x, y: tp.y - tension };
  const arrowAngle = Math.atan2(tp.y - cp2.y, tp.x - cp2.x);
  return { sp, cp1, cp2, tp, arrowAngle };
}

function drawArrowHead(ctx: CanvasRenderingContext2D, tip: Point, angle: number): void {
  const size = 8;
  const spread = Math.PI / 6;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - Math.cos(angle - spread) * size, tip.y - Math.sin(angle - spread) * size);
  ctx.lineTo(tip.x - Math.cos(angle + spread) * size, tip.y - Math.sin(angle + spread) * size);
  ctx.closePath();
  ctx.fill();
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: Map<string, BoardEdge>,
  nodes: Map<string, BoardNode>,
  nodeTypeMap: Map<string, NodeTypeConfig>
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const edge of edges.values()) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) continue;

    const sourceType = nodeTypeMap.get(source.typeId);
    const isContextSource = edge.edgeKind === "context" || sourceType?.category === "context";
    const isRunning = source.status === "running";

    if (isContextSource) {
      // Amber dashed — visually distinct from execution flow
      ctx.strokeStyle = "#f57c00";
      ctx.fillStyle = "#f57c00";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
    } else if (isRunning) {
      ctx.strokeStyle = "#0078d4";
      ctx.fillStyle = "#0078d4";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -animOffset;
    } else {
      ctx.strokeStyle = "#c0c0c0";
      ctx.fillStyle = "#c0c0c0";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
    }

    const { sp, cp1, cp2, tp, arrowAngle } = getEdgeBezier(source, target, edge.sourcePort ?? "default", nodeTypeMap, isContextSource);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, tp.x, tp.y);
    ctx.stroke();

    ctx.setLineDash([]);
    drawArrowHead(ctx, tp, arrowAngle);
  }

  ctx.restore();
}

function drawConnectionDraft(
  ctx: CanvasRenderingContext2D,
  sourceNode: BoardNode,
  sourcePortId: string,
  target: Point,
  nodeTypeMap: Map<string, NodeTypeConfig>
): void {
  const sourceType = nodeTypeMap.get(sourceNode.typeId);
  const sp = getPortPosition(sourceNode, sourcePortId, sourceType);
  const isContext = sourceType?.category === "context";

  let cp1: Point, cp2: Point;
  if (isContext) {
    // Exits bottom of context node, curves toward left side of eventual target
    const dv = Math.abs(target.y - sp.y);
    const dh = Math.abs(target.x - sp.x);
    const tension = Math.min(200, Math.max(60, dv * 0.4 + dh * 0.3));
    cp1 = { x: sp.x, y: sp.y + tension };
    cp2 = { x: target.x - tension, y: target.y };
  } else {
    const dy = target.y - sp.y;
    const tension = Math.min(180, Math.max(60, Math.abs(dy) * 0.5 + 40));
    cp1 = { x: sp.x, y: sp.y + tension };
    cp2 = { x: target.x, y: target.y - tension };
  }

  const draftColor = isContext ? "#f57c00" : "#0078d4";
  ctx.save();
  ctx.strokeStyle = draftColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -animOffset;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(sp.x, sp.y);
  ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = draftColor;
  ctx.beginPath();
  ctx.arc(target.x, target.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlacementPreview(
  ctx: CanvasRenderingContext2D,
  preview: (Point & { typeId: string }) | null,
  nodeType: NodeTypeConfig | null
): void {
  if (!preview || !nodeType) return;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.roundRect(preview.x, preview.y, nodeType.width, nodeType.height, 4);
  ctx.fillStyle = nodeType.fill;
  ctx.strokeStyle = nodeType.border;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export interface GraphState {
  nodes: Map<string, BoardNode>;
  edges: Map<string, BoardEdge>;
}

export function renderBoard(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: View,
  users: Map<string, BoardUser>,
  selfId: string | null,
  graphState: GraphState,
  interactionState: InteractionState,
  traceEvents: NodeRunTraceEvent[] = [],
  pendingApprovalNodeIds: Set<string> = new Set()
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const nodeTypeMap = getNodeTypeMap();
  const nodes = graphState?.nodes ?? new Map<string, BoardNode>();
  const edges = graphState?.edges ?? new Map<string, BoardEdge>();
  const lastTraceByNode = buildLastTraceByNode(traceEvents);

  animOffset = (animOffset + 0.8) % 14;
  pulsePhase = (pulsePhase + 0.06) % (Math.PI * 2);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  drawDots(ctx, width, height, view);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);

  drawEdges(ctx, edges, nodes, nodeTypeMap);

  for (const node of nodes.values()) {
    const isHoverNode = interactionState?.hoverPortInfo?.nodeId === node.id;
    drawNode(
      ctx,
      node,
      nodeTypeMap.get(node.typeId),
      interactionState?.selectedNodeId === node.id,
      interactionState?.pendingConnectionSourceId === node.id,
      isHoverNode ? (interactionState?.hoverPortInfo?.portId ?? null) : null,
      lastTraceByNode.get(node.id),
      pendingApprovalNodeIds.has(node.id)
    );
  }

  // Draft connection line while connecting
  if (interactionState?.pendingConnectionSourceId && interactionState.connectionDraftTarget) {
    const srcNode = nodes.get(interactionState.pendingConnectionSourceId);
    if (srcNode) {
      drawConnectionDraft(
        ctx,
        srcNode,
        interactionState.pendingConnectionSourcePort ?? "default",
        interactionState.connectionDraftTarget,
        nodeTypeMap
      );
    }
  }

  drawPlacementPreview(
    ctx,
    interactionState?.placementPreview ?? null,
    interactionState?.placementPreview
      ? (nodeTypeMap.get(interactionState.placementPreview.typeId) ?? null)
      : null
  );

  ctx.restore();

  for (const user of users.values()) {
    if (user.id !== selfId && (!user.cursorWorkspace || user.cursorWorkspace === "canvas")) {
      drawCursor(ctx, user, view);
    }
  }
}
