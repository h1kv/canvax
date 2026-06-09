import { useCallback, useEffect, useRef, useState } from "react";
import { clamp, screenToWorld, snapToGrid } from "../geometry.js";
import type { PlanEdge, PlanNode, PlanNodeKind, Point, View } from "../../types/index.js";
import type { PlanInteractionState } from "../renderPlan.js";

const PLAN_NODE_WIDTH = 260;
const PLAN_NODE_HEIGHT: Record<PlanNodeKind, number> = {
  note: 150,
  task: 132,
  decision: 132,
  risk: 132,
  "flow-step": 132,
  "proposed-agent": 132,
  "proposed-tool": 132,
  "approval-point": 132,
  context: 132,
};

function getCanvasPoint(canvas: HTMLCanvasElement, event: { clientX: number; clientY: number }): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function sendJson(socketRef: React.MutableRefObject<WebSocket | null>, message: unknown): void {
  if (socketRef.current?.readyState === WebSocket.OPEN) {
    socketRef.current.send(JSON.stringify(message));
  }
}

function findPlanNodeAtPoint(point: Point, nodes: Map<string, PlanNode>): PlanNode | null {
  const arr = Array.from(nodes.values());
  for (let i = arr.length - 1; i >= 0; i--) {
    const node = arr[i];
    if (
      point.x >= node.x &&
      point.x <= node.x + node.width &&
      point.y >= node.y &&
      point.y <= node.y + node.height
    ) {
      return node;
    }
  }
  return null;
}

export interface UsePlanInteractionParams {
  enabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewRef: React.MutableRefObject<View>;
  planNodesRef: React.MutableRefObject<Map<string, PlanNode>>;
  planEdgesRef: React.MutableRefObject<Map<string, PlanEdge>>;
  socketRef: React.MutableRefObject<WebSocket | null>;
  interactionStateRef: React.MutableRefObject<PlanInteractionState>;
  requestRender: () => void;
}

export function usePlanInteraction(params: UsePlanInteractionParams) {
  const {
    enabled,
    canvasRef,
    viewRef,
    planNodesRef,
    socketRef,
    interactionStateRef,
    requestRender,
  } = params;

  const [mode, setMode] = useState<"select" | "place" | "connect">("select");
  const [placementKind, setPlacementKind] = useState<PlanNodeKind>("note");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [hoverWorldPoint, setHoverWorldPoint] = useState<Point | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  const panRef = useRef<{ pointerId: number; lastPoint: Point } | null>(null);
  const dragRef = useRef<{ pointerId: number; nodeId: string; offset: Point; lastPosition: Point } | null>(null);
  const lastCursorSentRef = useRef(0);

  const applyView = useCallback((nextView: View) => {
    viewRef.current = nextView;
    setZoomPercent(Math.round(nextView.scale * 100));
    requestRender();
  }, [requestRender, viewRef]);

  function sendCursor(point: Point) {
    const now = performance.now();
    if (now - lastCursorSentRef.current < 40) return;
    lastCursorSentRef.current = now;
    sendJson(socketRef, { type: "cursor:update", point, workspaceTab: "plan" });
  }

  function clearConnectionDraft() {
    interactionStateRef.current = {
      ...interactionStateRef.current,
      connectionDraftTarget: null,
    };
  }

  function setBoardMode(nextMode: "select" | "place" | "connect", kind: PlanNodeKind = placementKind) {
    setMode(nextMode);
    setPlacementKind(kind);
    if (nextMode !== "connect") {
      setConnectionSourceId(null);
      clearConnectionDraft();
    }
  }

  function createPlanNode(kind: PlanNodeKind, worldPoint: Point) {
    const position = snapToGrid({
      x: worldPoint.x - PLAN_NODE_WIDTH / 2,
      y: worldPoint.y - PLAN_NODE_HEIGHT[kind] / 2,
    });
    sendJson(socketRef, {
      type: "plan:node:create",
      kind,
      title: kind.replace("-", " "),
      body: "",
      position,
    });
  }

  function updateSelectedNode(patch: Record<string, unknown>) {
    if (!selectedNodeId) return;
    sendJson(socketRef, { type: "plan:node:update", nodeId: selectedNodeId, patch });
  }

  function deleteSelectedNode() {
    if (!selectedNodeId) return;
    sendJson(socketRef, { type: "plan:node:delete", nodeId: selectedNodeId });
    setSelectedNodeId(null);
    setConnectionSourceId(null);
  }

  function connectFromSelected() {
    if (!selectedNodeId) return;
    setMode("connect");
    setConnectionSourceId(selectedNodeId);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!enabled) return;
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const screenPoint = getCanvasPoint(canvas, event);
    const worldPoint = screenToWorld(screenPoint, viewRef.current);
    const hitNode = findPlanNodeAtPoint(worldPoint, planNodesRef.current);
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    setHoverWorldPoint(worldPoint);
    sendCursor(worldPoint);

    if (mode === "place") {
      if (!hitNode) createPlanNode(placementKind, worldPoint);
      return;
    }

    if (connectionSourceId) {
      if (hitNode && hitNode.id !== connectionSourceId) {
        sendJson(socketRef, {
          type: "plan:edge:create",
          sourceId: connectionSourceId,
          targetId: hitNode.id,
        });
        setSelectedNodeId(hitNode.id);
      }
      setConnectionSourceId(null);
      setMode("select");
      clearConnectionDraft();
      return;
    }

    if (mode === "connect") {
      if (hitNode) {
        setSelectedNodeId(hitNode.id);
        setConnectionSourceId(hitNode.id);
      }
      return;
    }

    if (hitNode) {
      setSelectedNodeId(hitNode.id);
      dragRef.current = {
        pointerId: event.pointerId,
        nodeId: hitNode.id,
        offset: { x: worldPoint.x - hitNode.x, y: worldPoint.y - hitNode.y },
        lastPosition: { x: hitNode.x, y: hitNode.y },
      };
      return;
    }

    setSelectedNodeId(null);
    panRef.current = { pointerId: event.pointerId, lastPoint: screenPoint };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const screenPoint = getCanvasPoint(canvas, event);
    const worldPoint = screenToWorld(screenPoint, viewRef.current);
    setHoverWorldPoint(worldPoint);
    sendCursor(worldPoint);

    interactionStateRef.current = {
      ...interactionStateRef.current,
      connectionDraftTarget: connectionSourceId ? worldPoint : null,
    };

    if (dragRef.current?.pointerId === event.pointerId) {
      const node = planNodesRef.current.get(dragRef.current.nodeId);
      if (!node) return;
      const position = snapToGrid({
        x: worldPoint.x - dragRef.current.offset.x,
        y: worldPoint.y - dragRef.current.offset.y,
      });
      if (position.x === dragRef.current.lastPosition.x && position.y === dragRef.current.lastPosition.y) {
        requestRender();
        return;
      }
      dragRef.current.lastPosition = position;
      planNodesRef.current.set(node.id, { ...node, x: position.x, y: position.y });
      sendJson(socketRef, { type: "plan:node:update", nodeId: node.id, patch: { position } });
      requestRender();
      return;
    }

    if (panRef.current?.pointerId === event.pointerId) {
      const lastPoint = panRef.current.lastPoint;
      applyView({
        ...viewRef.current,
        x: viewRef.current.x + screenPoint.x - lastPoint.x,
        y: viewRef.current.y + screenPoint.y - lastPoint.y,
      });
      panRef.current.lastPoint = screenPoint;
    }

    requestRender();
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function adjustZoom(multiplier: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const screenPoint = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    const worldPoint = screenToWorld(screenPoint, viewRef.current);
    const nextScale = clamp(viewRef.current.scale * multiplier, 0.25, 4);
    applyView({
      x: screenPoint.x - worldPoint.x * nextScale,
      y: screenPoint.y - worldPoint.y * nextScale,
      scale: nextScale,
    });
  }

  function resetZoom() {
    applyView({ ...viewRef.current, scale: 1 });
  }

  useEffect(() => {
    if (!enabled) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const screenPoint = getCanvasPoint(canvas!, event);
      if (event.ctrlKey || event.metaKey) {
        const worldPoint = screenToWorld(screenPoint, viewRef.current);
        const zoomDelta = Math.exp(-event.deltaY * 0.002);
        const nextScale = clamp(viewRef.current.scale * zoomDelta, 0.25, 4);
        applyView({
          x: screenPoint.x - worldPoint.x * nextScale,
          y: screenPoint.y - worldPoint.y * nextScale,
          scale: nextScale,
        });
        return;
      }
      applyView({
        ...viewRef.current,
        x: viewRef.current.x - event.deltaX,
        y: viewRef.current.y - event.deltaY,
      });
    }

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [applyView, canvasRef, enabled, viewRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (isEditable) return;
      if (event.key === "Escape") {
        setMode("select");
        setConnectionSourceId(null);
        clearConnectionDraft();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        if (!selectedNodeId) return;
        event.preventDefault();
        deleteSelectedNode();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          adjustZoom(1.15);
        } else if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          adjustZoom(0.85);
        } else if (event.key === "0") {
          event.preventDefault();
          resetZoom();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    const placementPreview =
      mode === "place" && hoverWorldPoint
        ? {
            kind: placementKind,
            ...snapToGrid({
              x: hoverWorldPoint.x - PLAN_NODE_WIDTH / 2,
              y: hoverWorldPoint.y - PLAN_NODE_HEIGHT[placementKind] / 2,
            }),
          }
        : null;
    interactionStateRef.current = {
      selectedNodeId,
      placementPreview,
      connectionSourceId,
      connectionDraftTarget: interactionStateRef.current.connectionDraftTarget,
    };
    requestRender();
  }, [connectionSourceId, hoverWorldPoint, interactionStateRef, mode, placementKind, requestRender, selectedNodeId]);

  const selectedNode = selectedNodeId ? (planNodesRef.current.get(selectedNodeId) ?? null) : null;

  return {
    mode,
    modeLabel:
      mode === "place"
        ? `Plan · ${placementKind.replace("-", " ")}`
        : connectionSourceId
          ? "Plan connector - pick target"
          : mode === "connect"
            ? "Plan connector"
            : "Plan pointer",
    placementKind,
    selectedNodeId,
    selectedNode,
    zoomPercent,
    setBoardMode,
    updateSelectedNode,
    deleteSelectedNode,
    connectFromSelected,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    adjustZoom,
    resetZoom,
  };
}
