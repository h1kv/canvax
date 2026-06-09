import type { BoardUser, PlanEdge, PlanNode, Point, View } from "../types/index.js";
import { clamp, worldToScreen } from "./geometry.js";

export interface PlanInteractionState {
  selectedNodeId: string | null;
  placementPreview: (Point & { kind: PlanNode["kind"] }) | null;
  connectionSourceId: string | null;
  connectionDraftTarget: Point | null;
}

export interface PlanGraphState {
  nodes: Map<string, PlanNode>;
  edges: Map<string, PlanEdge>;
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
  const labelHeight = 22;
  const labelX = point.x + 10;
  const labelY = point.y + 10;

  ctx.save();
  ctx.font = `12px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
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

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function drawPlanNode(ctx: CanvasRenderingContext2D, node: PlanNode, selected: boolean): void {
  const { x, y, width, height } = node;
  const rail = node.color || "#6b6a62";

  ctx.save();
  ctx.shadowColor = selected ? `${rail}55` : "rgba(0,0,0,0.08)";
  ctx.shadowBlur = selected ? 12 : 5;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fillStyle = "#fffdf8";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.strokeStyle = selected ? rail : "#d7d0c3";
  ctx.lineWidth = selected ? 2 : 1.25;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.clip();
  ctx.fillStyle = rail;
  ctx.fillRect(x, y, 6, height);
  ctx.restore();

  ctx.fillStyle = rail;
  ctx.font = `700 10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.letterSpacing = "0.07em";
  ctx.textBaseline = "top";
  ctx.fillText(node.kind.replace("-", " ").toUpperCase(), x + 16, y + 12);
  ctx.letterSpacing = "0em";

  ctx.fillStyle = "#2f2f2f";
  ctx.font = `600 14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const titleLines = wrapLines(ctx, node.title || "Untitled", width - 32, 2);
  titleLines.forEach((line, index) => ctx.fillText(line, x + 16, y + 32 + index * 17));

  if (node.body) {
    ctx.fillStyle = "#6f6b63";
    ctx.font = `12px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const bodyY = y + 68;
    const bodyLines = wrapLines(ctx, node.body, width - 32, Math.max(1, Math.floor((height - 82) / 16)));
    bodyLines.forEach((line, index) => ctx.fillText(line, x + 16, bodyY + index * 16));
  }

  ctx.restore();
}

function drawPlanEdges(
  ctx: CanvasRenderingContext2D,
  edges: Map<string, PlanEdge>,
  nodes: Map<string, PlanNode>
): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#b9b1a3";
  ctx.fillStyle = "#8f877b";
  ctx.lineWidth = 1.4;

  for (const edge of edges.values()) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) continue;
    const sx = source.x + source.width;
    const sy = source.y + source.height / 2;
    const tx = target.x;
    const ty = target.y + target.height / 2;
    const tension = Math.max(60, Math.min(180, Math.abs(tx - sx) * 0.35));

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx + tension, sy, tx - tension, ty, tx, ty);
    ctx.stroke();

    const angle = Math.atan2(ty - sy, tx - sx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - Math.cos(angle - Math.PI / 7) * 8, ty - Math.sin(angle - Math.PI / 7) * 8);
    ctx.lineTo(tx - Math.cos(angle + Math.PI / 7) * 8, ty - Math.sin(angle + Math.PI / 7) * 8);
    ctx.closePath();
    ctx.fill();

    if (edge.label) {
      const lx = (sx + tx) / 2;
      const ly = (sy + ty) / 2 - 8;
      ctx.font = `10px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillStyle = "#7f776d";
      ctx.fillText(edge.label, lx + 4, ly);
      ctx.fillStyle = "#8f877b";
    }
  }

  ctx.restore();
}

function drawPlacementPreview(
  ctx: CanvasRenderingContext2D,
  preview: PlanInteractionState["placementPreview"]
): void {
  if (!preview) return;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.roundRect(preview.x, preview.y, 260, preview.kind === "note" ? 150 : 132, 6);
  ctx.fillStyle = "#fffdf8";
  ctx.strokeStyle = "#8f877b";
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawConnectionDraft(
  ctx: CanvasRenderingContext2D,
  source: PlanNode,
  target: Point
): void {
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tension = Math.max(60, Math.min(180, Math.abs(target.x - sx) * 0.35));

  ctx.save();
  ctx.strokeStyle = "#7f776d";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.bezierCurveTo(sx + tension, sy, target.x - tension, target.y, target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(target.x, target.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#7f776d";
  ctx.fill();
  ctx.restore();
}

export function renderPlanBoard(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: View,
  users: Map<string, BoardUser>,
  selfId: string | null,
  graphState: PlanGraphState,
  interactionState: PlanInteractionState
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const nodes = graphState.nodes ?? new Map<string, PlanNode>();
  const edges = graphState.edges ?? new Map<string, PlanEdge>();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  drawDots(ctx, width, height, view);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  drawPlanEdges(ctx, edges, nodes);

  for (const node of nodes.values()) {
    drawPlanNode(ctx, node, interactionState.selectedNodeId === node.id);
  }

  if (interactionState.connectionSourceId && interactionState.connectionDraftTarget) {
    const source = nodes.get(interactionState.connectionSourceId);
    if (source) drawConnectionDraft(ctx, source, interactionState.connectionDraftTarget);
  }

  drawPlacementPreview(ctx, interactionState.placementPreview);
  ctx.restore();

  for (const user of users.values()) {
    if (user.id !== selfId && user.cursorWorkspace === "plan") drawCursor(ctx, user, view);
  }
}
