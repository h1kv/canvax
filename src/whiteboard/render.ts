import { NODE_REGISTRY, SDLC_NODE_TYPES } from "../../shared/nodeRegistry.js";
import type { BoardUser, EdgeV2, InteractionState, NodeV2, NodeV2Type, Point, View } from "../types/index.js";
import { clamp, worldToScreen } from "./geometry.js";

const FONT_BASE = `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

// Port geometry (in node-local space)
const FLOW_PORT_R = 5;
const MIDPUT_PORT_SIZE = 7; // half-width of diamond

function nodeFlowInCenter(node: NodeV2): Point {
  return { x: node.x + node.width / 2, y: node.y };
}
function nodeFlowOutCenter(node: NodeV2): Point {
  // For review nodes, approve output is offset left
  if (node.type === "review") return { x: node.x + node.width * 0.33, y: node.y + node.height };
  return { x: node.x + node.width / 2, y: node.y + node.height };
}
function nodeRejectOutCenter(node: NodeV2): Point {
  return { x: node.x + node.width * 0.67, y: node.y + node.height };
}
function nodeMidputLeftCenter(node: NodeV2): Point {
  return { x: node.x, y: node.y + node.height / 2 };
}
function nodeMidputRightCenter(node: NodeV2): Point {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

export function getPortWorldPosition(
  node: NodeV2,
  port: "flowIn" | "flowOut" | "rejectOut" | "midputLeft" | "midputRight"
): Point {
  switch (port) {
    case "flowIn":      return nodeFlowInCenter(node);
    case "flowOut":     return nodeFlowOutCenter(node);
    case "rejectOut":   return nodeRejectOutCenter(node);
    case "midputLeft":  return nodeMidputLeftCenter(node);
    case "midputRight": return nodeMidputRightCenter(node);
  }
}

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
  const paddingX = 7;
  const labelX = point.x + 10;
  const labelY = point.y + 10;

  ctx.save();
  ctx.font = `12px ${FONT_BASE}`;
  const labelWidth = Math.ceil(ctx.measureText(label).width) + paddingX * 2;

  ctx.fillStyle = user.color || "#2d2d2d";
  ctx.beginPath();
  ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, 22, 6);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, labelX + paddingX, labelY + 15);
  ctx.restore();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "...";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

function statusColor(status: NodeV2["status"]): string {
  switch (status) {
    case "running": return "#e6a817";
    case "done":    return "#1a9e5a";
    case "error":   return "#d93f3f";
    default:        return "transparent";
  }
}

function drawFlowPort(ctx: CanvasRenderingContext2D, point: Point, accent: string, filled: boolean): void {
  ctx.beginPath();
  ctx.arc(point.x, point.y, FLOW_PORT_R, 0, Math.PI * 2);
  ctx.fillStyle = filled ? accent : "#ffffff";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
}

function drawMidputPort(ctx: CanvasRenderingContext2D, point: Point, accent: string): void {
  const s = MIDPUT_PORT_SIZE;
  ctx.beginPath();
  ctx.moveTo(point.x, point.y - s);
  ctx.lineTo(point.x + s, point.y);
  ctx.lineTo(point.x, point.y + s);
  ctx.lineTo(point.x - s, point.y);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
}

function drawNode(ctx: CanvasRenderingContext2D, node: NodeV2, selected: boolean): void {
  const definition = NODE_REGISTRY[node.type];
  if (!definition) return;
  const accent = definition.accent;
  const isSDLC = SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number]);

  // Parallel node: draw stacked cards behind
  if (node.type === "parallel") {
    const branches = node.config?.branches ?? [];
    const stackCount = Math.min(branches.length, 3);
    for (let i = stackCount; i >= 1; i--) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(node.x + i * 5, node.y + i * 4, node.width, node.height, 4);
      ctx.fillStyle = `rgba(255,255,255,${0.55 - i * 0.12})`;
      ctx.strokeStyle = `${accent}${i === 1 ? "55" : "33"}`;
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Drop shadow
  ctx.save();
  ctx.shadowColor = selected ? `${accent}44` : "rgba(0,0,0,0.08)";
  ctx.shadowBlur = selected ? 12 : 5;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.roundRect(node.x, node.y, node.width, node.height, 4);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Border
  ctx.beginPath();
  ctx.roundRect(node.x, node.y, node.width, node.height, 4);
  ctx.strokeStyle = selected ? accent : `${accent}88`;
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.stroke();

  // Accent header bar
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(node.x, node.y, node.width, node.height, 4);
  ctx.clip();
  ctx.fillStyle = accent;
  ctx.fillRect(node.x, node.y, node.width, 28);
  ctx.restore();

  // Status dot in header
  const dotColor = statusColor(node.status ?? "idle");
  if (dotColor !== "transparent") {
    ctx.beginPath();
    ctx.arc(node.x + node.width - 12, node.y + 14, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }

  // Header label (type role)
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 10px ${FONT_BASE}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(definition.label.toUpperCase(), node.x + 10, node.y + 14);

  // Node title
  ctx.fillStyle = "#333333";
  ctx.font = `600 14px ${FONT_BASE}`;
  ctx.textBaseline = "top";
  const titleY = isSDLC ? node.y + 36 : node.y + 40;
  ctx.fillText(truncateText(ctx, node.title || definition.defaultTitle, node.width - 20), node.x + 10, titleY);

  // Subtitle for SDLC nodes
  if (isSDLC) {
    ctx.fillStyle = "#999999";
    ctx.font = `11px ${FONT_BASE}`;
    if (node.type === "parallel") {
      const branches = node.config?.branches ?? [];
      const dots = branches.map((b) => b.label || "Agent").join(" · ");
      ctx.fillText(truncateText(ctx, dots || "No branches", node.width - 20), node.x + 10, node.y + 56);
      // Branch count badge
      ctx.save();
      ctx.fillStyle = `${accent}18`;
      ctx.strokeStyle = `${accent}55`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(node.x + node.width - 36, node.y + 50, 26, 16, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.font = `700 10px ${FONT_BASE}`;
      ctx.textAlign = "center";
      ctx.fillText(`×${branches.length}`, node.x + node.width - 23, node.y + 58 + 0.5);
      ctx.textAlign = "left";
      ctx.restore();
    } else {
      ctx.fillText(definition.label, node.x + 10, node.y + 56);
    }
  }

  ctx.restore();

  // Flow in port
  if (definition.hasFlowIn) {
    drawFlowPort(ctx, nodeFlowInCenter(node), accent, false);
  }

  // Flow out port (approve on Review, normal otherwise)
  if (definition.hasFlowOut) {
    const approveColor = node.type === "review" ? "#1a9e5a" : accent;
    const approvePoint = nodeFlowOutCenter(node);
    drawFlowPort(ctx, approvePoint, approveColor, false);
    if (node.type === "review") {
      ctx.save();
      ctx.font = `500 9px ${FONT_BASE}`;
      ctx.fillStyle = "#1a9e5a";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("Approve", approvePoint.x, approvePoint.y - 4);
      ctx.restore();
    }
  }

  // Reject port (Review nodes only)
  if (definition.hasRejectOut) {
    const rejectPoint = nodeRejectOutCenter(node);
    drawFlowPort(ctx, rejectPoint, "#d93f3f", false);
    ctx.save();
    ctx.font = `500 9px ${FONT_BASE}`;
    ctx.fillStyle = "#d93f3f";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("Reject", rejectPoint.x, rejectPoint.y - 4);
    ctx.restore();
  }

  // Midput ports
  if (definition.hasMidputIn) {
    drawMidputPort(ctx, nodeMidputLeftCenter(node), accent);
    drawMidputPort(ctx, nodeMidputRightCenter(node), accent);
  }
  if (definition.hasMidputOut) {
    drawMidputPort(ctx, nodeMidputRightCenter(node), accent);
  }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  edge: EdgeV2,
  nodes: Map<string, NodeV2>
): void {
  const source = nodes.get(edge.sourceId);
  const target = nodes.get(edge.targetId);
  if (!source || !target) return;

  const sourceDef = NODE_REGISTRY[source.type];
  const targetDef = NODE_REGISTRY[target.type];
  if (!sourceDef || !targetDef) return;

  let start: Point;
  let end: Point;

  if (edge.kind === "flow") {
    start = nodeFlowOutCenter(source); // handles review approve offset
    end = nodeFlowInCenter(target);
  } else if (edge.kind === "reject") {
    start = nodeRejectOutCenter(source);
    end = nodeFlowInCenter(target);
  } else {
    // midput: context node attaches right → target left
    start = nodeMidputRightCenter(source);
    end = nodeMidputLeftCenter(target);
  }

  const isVertical = edge.kind === "flow" || edge.kind === "reject";
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const curveMag = isVertical
    ? Math.max(Math.abs(dy) * 0.4, 40)
    : Math.max(Math.abs(dx) * 0.4, 40);

  const cp1x = isVertical ? start.x : start.x + curveMag;
  const cp1y = isVertical ? start.y + curveMag : start.y;
  const cp2x = isVertical ? end.x : end.x - curveMag;
  const cp2y = isVertical ? end.y - curveMag : end.y;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, end.x, end.y);

  if (edge.kind === "midput") {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#aaaaaa";
  } else if (edge.kind === "reject") {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#d93f3f";
  } else {
    ctx.setLineDash([]);
    ctx.strokeStyle = sourceDef.accent;
  }

  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawConnectionDraft(
  ctx: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  kind: "flow" | "midput" | "reject"
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);

  if (kind === "flow" || kind === "reject") {
    const curveMag = Math.max(Math.abs(end.y - start.y) * 0.4, 40);
    ctx.bezierCurveTo(start.x, start.y + curveMag, end.x, end.y - curveMag, end.x, end.y);
    ctx.setLineDash(kind === "reject" ? [6, 4] : []);
    ctx.strokeStyle = kind === "reject" ? "#d93f3f" : "#888888";
  } else {
    const curveMag = Math.max(Math.abs(end.x - start.x) * 0.4, 40);
    ctx.bezierCurveTo(start.x + curveMag, start.y, end.x - curveMag, end.y, end.x, end.y);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#aaaaaa";
  }

  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.restore();
}

function drawPlacementPreview(
  ctx: CanvasRenderingContext2D,
  preview: (Point & { type: NodeV2Type }) | null
): void {
  if (!preview) return;
  const definition = NODE_REGISTRY[preview.type];
  if (!definition) return;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.roundRect(preview.x, preview.y, definition.width, definition.height, 4);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = definition.accent;
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export interface GraphState {
  nodes: Map<string, NodeV2>;
  edges: Map<string, EdgeV2>;
}

type PreviewCollection<T extends { id: string }> = ReadonlyMap<string, T> | readonly T[] | null | undefined;

export interface GraphPreviewState {
  nodes?: PreviewCollection<NodeV2>;
  edges?: PreviewCollection<EdgeV2>;
}

interface NormalizedGraphPreview {
  nodes: Map<string, NodeV2>;
  edges: Map<string, EdgeV2>;
  nodeLookup: Map<string, NodeV2>;
}

function normalizePreviewItems<T extends { id: string }>(items: PreviewCollection<T>): Map<string, T> {
  if (!items) return new Map<string, T>();
  if (Array.isArray(items)) return new Map((items as readonly T[]).map((item) => [item.id, item]));
  return new Map(Array.from((items as ReadonlyMap<string, T>).entries()));
}

function normalizeGraphPreview(
  preview: GraphPreviewState | null | undefined,
  committedNodes: Map<string, NodeV2>
): NormalizedGraphPreview | null {
  if (!preview) return null;

  const previewNodes = normalizePreviewItems(preview.nodes);
  const previewEdges = normalizePreviewItems(preview.edges);
  if (previewNodes.size === 0 && previewEdges.size === 0) return null;

  const nodeLookup = new Map(committedNodes);
  for (const node of previewNodes.values()) {
    nodeLookup.set(node.id, node);
  }

  return { nodes: previewNodes, edges: previewEdges, nodeLookup };
}

function drawGraphPreviewEdges(ctx: CanvasRenderingContext2D, preview: NormalizedGraphPreview | null): void {
  if (!preview) return;

  ctx.save();
  ctx.globalAlpha = 0.55;
  for (const edge of preview.edges.values()) {
    drawEdge(ctx, edge, preview.nodeLookup);
  }
  ctx.restore();
}

function drawGraphPreviewNodes(ctx: CanvasRenderingContext2D, preview: NormalizedGraphPreview | null): void {
  if (!preview) return;

  ctx.save();
  ctx.globalAlpha = 0.62;
  for (const node of preview.nodes.values()) {
    drawNode(ctx, node, false);
  }
  ctx.restore();
}

export function renderBoard(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: View,
  users: Map<string, BoardUser>,
  selfId: string | null,
  graphState: GraphState,
  interactionState: InteractionState,
  graphPreview?: GraphPreviewState | null
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const nodeMap = graphState.nodes ?? new Map<string, NodeV2>();
  const edgeMap = graphState.edges ?? new Map<string, EdgeV2>();
  const normalizedGraphPreview = normalizeGraphPreview(graphPreview, nodeMap);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  drawDots(ctx, width, height, view);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);

  // Edges below nodes
  for (const edge of edgeMap.values()) {
    drawEdge(ctx, edge, nodeMap);
  }

  drawGraphPreviewEdges(ctx, normalizedGraphPreview);

  // Connection draft
  const { pendingConnectionSourceId, pendingConnectionKind, connectionDraftTarget } = interactionState;
  if (pendingConnectionSourceId && pendingConnectionKind && connectionDraftTarget) {
    const sourceNode = nodeMap.get(pendingConnectionSourceId);
    if (sourceNode) {
      const startPort = pendingConnectionKind === "flow" ? "flowOut" : "midputRight";
      const start = getPortWorldPosition(sourceNode, startPort);
      drawConnectionDraft(ctx, start, connectionDraftTarget, pendingConnectionKind);
    }
  }

  for (const node of nodeMap.values()) {
    drawNode(ctx, node, interactionState.selectedNodeId === node.id);
  }
  drawGraphPreviewNodes(ctx, normalizedGraphPreview);
  drawPlacementPreview(ctx, interactionState.placementPreview);

  ctx.restore();

  for (const user of users.values()) {
    if (user.id !== selfId && (!user.cursorWorkspace || user.cursorWorkspace === "canvas")) {
      drawCursor(ctx, user, view);
    }
  }
}
