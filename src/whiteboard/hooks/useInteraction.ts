import { useCallback, useEffect, useRef, useState } from "react";
import { clamp, distance, findNodeAtPoint, screenToWorld, snapToGrid } from "../geometry.js";
import type {
  View,
  BoardNode,
  BoardEdge,
  InteractionState,
  NodeTypeConfig,
  Point,
} from "../../types/index.js";

function getCanvasPoint(canvas: HTMLCanvasElement, event: { clientX: number; clientY: number }): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function getPointerPair(pointers: Map<number, Point>): [Point, Point] | null {
  const values = Array.from(pointers.values());
  return values.length >= 2 ? [values[0], values[1]] : null;
}

function getMidpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function sendJson(socketRef: React.MutableRefObject<WebSocket | null>, message: unknown): void {
  if (socketRef.current?.readyState === WebSocket.OPEN) {
    socketRef.current.send(JSON.stringify(message));
  }
}

function createClientId(prefix: string): string {
  if (window.crypto?.randomUUID) {
    return `${prefix}_${window.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface UseInteractionParams {
  enabled?: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewRef: React.MutableRefObject<View>;
  nodesRef: React.MutableRefObject<Map<string, BoardNode>>;
  edgesRef: React.MutableRefObject<Map<string, BoardEdge>>;
  socketRef: React.MutableRefObject<WebSocket | null>;
  interactionStateRef: React.MutableRefObject<InteractionState>;
  requestRender: () => void;
  nodeTypes: NodeTypeConfig[];
}

export interface ContextMenuState {
  screenX: number;
  screenY: number;
  nodeId: string | null;
}

export interface UseInteractionResult {
  mode: string;
  placementTypeId: string;
  selectedNodeId: string | null;
  pendingConnectionSourceId: string | null;
  selectedLabelDraft: string;
  zoomPercent: number;
  contextMenu: ContextMenuState | null;
  handlePointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  setBoardMode: (mode: string, typeId?: string) => void;
  updateSelectedNodeLabel: (label: string) => void;
  deleteSelectedNode: () => void;
  adjustZoom: (factor: number) => void;
  resetZoom: () => void;
  setSelectedLabelDraft: React.Dispatch<React.SetStateAction<string>>;
  closeContextMenu: () => void;
  connectFromNode: (nodeId: string) => void;
}

export function useInteraction(params: UseInteractionParams): UseInteractionResult {
  const {
    enabled = true,
    canvasRef,
    viewRef,
    nodesRef,
    edgesRef,
    socketRef,
    interactionStateRef,
    requestRender,
    nodeTypes,
  } = params;

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  function closeContextMenu() { setContextMenu(null); }

  function handleContextMenu(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!enabled) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const worldPoint = screenToWorld(screenPoint, viewRef.current);
    const hitNode = findNodeAtPoint(worldPoint, nodesRef.current);
    if (hitNode) setSelectedNodeId(hitNode.id);
    setContextMenu({ screenX: screenPoint.x, screenY: screenPoint.y, nodeId: hitNode?.id ?? null });
  }

  function connectFromNode(nodeId: string) {
    const node = nodesRef.current.get(nodeId);
    if (!node) return;
    startConnection(node, findClosestOutputPort(node, { x: node.x + node.width / 2, y: node.y + node.height }));
    setContextMenu(null);
  }

  const historyRef = useRef<Array<() => void>>([]);

  function pushHistory(undoFn: () => void) {
    historyRef.current.push(undoFn);
    if (historyRef.current.length > 50) historyRef.current.shift();
  }

  function applyUndo() {
    const fn = historyRef.current.pop();
    if (fn) fn();
  }

  const pendingSourcePortRef = useRef<string>("default");

  // Returns the x position of a port on a node's bottom edge
  function portX(node: BoardNode, portIndex: number, totalPorts: number): number {
    if (totalPorts <= 1) return node.x + node.width / 2;
    const padding = node.width * 0.2;
    const span = node.width - padding * 2;
    return node.x + padding + (span / (totalPorts - 1)) * portIndex;
  }

  // Finds which output port the cursor is over (across all nodes)
  function findOutputPortAtPoint(worldPoint: Point): { node: BoardNode; portId: string } | null {
    const HIT_R = 12 / viewRef.current.scale; // world-space hit radius, scale-aware
    for (const node of nodesRef.current.values()) {
      const nodeType = nodeTypes.find((t) => t.id === node.typeId);

      const ports = nodeType?.outputPorts ?? [];
      if (ports.length === 0) {
        const px = node.x + node.width / 2;
        const py = node.y + node.height;
        if (Math.hypot(worldPoint.x - px, worldPoint.y - py) <= HIT_R) {
          return { node, portId: "default" };
        }
      } else {
        for (let i = 0; i < ports.length; i++) {
          const px = portX(node, i, ports.length);
          const py = node.y + node.height;
          if (Math.hypot(worldPoint.x - px, worldPoint.y - py) <= HIT_R) {
            return { node, portId: ports[i].id };
          }
        }
      }
    }
    return null;
  }

  // Used by C-key / right-click connect: pick the best port based on click position
  function findClosestOutputPort(node: BoardNode, worldPoint: Point): string {
    const nodeType = nodeTypes.find((t) => t.id === node.typeId);
    const ports = nodeType?.outputPorts ?? [];
    if (ports.length === 0) return "default";
    let closest = ports[0].id;
    let minDist = Infinity;
    for (let i = 0; i < ports.length; i++) {
      const px = portX(node, i, ports.length);
      const py = node.y + node.height;
      const d = Math.hypot(worldPoint.x - px, worldPoint.y - py);
      if (d < minDist) { minDist = d; closest = ports[i].id; }
    }
    return closest;
  }

  function startConnection(node: BoardNode, portId: string) {
    setSelectedNodeId(node.id);
    setPendingConnectionSourceId(node.id);
    pendingSourcePortRef.current = portId;
  }

  function completeConnection(srcId: string, tgtId: string) {
    const sourcePort = pendingSourcePortRef.current;
    sendJson(socketRef, { type: "edge:create", sourceId: srcId, targetId: tgtId, sourcePort });
    setPendingConnectionSourceId(null);
    pendingSourcePortRef.current = "default";
    interactionStateRef.current = {
      ...interactionStateRef.current,
      connectionDraftTarget: null,
    };
    pushHistory(() => {
      for (const [edgeId, edge] of edgesRef.current.entries()) {
        if (edge.sourceId === srcId && edge.targetId === tgtId) {
          sendJson(socketRef, { type: "edge:delete", edgeId });
          edgesRef.current.delete(edgeId);
          requestRender();
          break;
        }
      }
    });
  }

  function cancelConnection() {
    setPendingConnectionSourceId(null);
    pendingSourcePortRef.current = "default";
    interactionStateRef.current = {
      ...interactionStateRef.current,
      connectionDraftTarget: null,
    };
    requestRender();
  }

  const pointersRef = useRef<Map<number, Point>>(new Map());
  const panRef = useRef<{ pointerId: number; lastPoint: Point } | null>(null);
  const pinchRef = useRef<{
    distance: number;
    startScale: number;
    worldMidpoint: Point;
  } | null>(null);
  const gestureRef = useRef<{ startScale: number; worldPoint: Point } | null>(null);
  const nodeDragRef = useRef<{ nodeId: string; offset: Point; startPos: Point; hasMoved: boolean } | null>(null);
  const lastCursorSentRef = useRef<number>(0);

  const [mode, setMode] = useState<string>("select");
  const [placementTypeId, setPlacementTypeId] = useState<string>("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pendingConnectionSourceId, setPendingConnectionSourceId] = useState<string | null>(null);
  const [hoverWorldPoint, setHoverWorldPoint] = useState<Point | null>(null);
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [selectedLabelDraft, setSelectedLabelDraft] = useState<string>("");

  // Sync selectedLabelDraft when selectedNodeId changes
  useEffect(() => {
    if (!selectedNodeId) {
      setSelectedLabelDraft("");
      return;
    }
    const node = nodesRef.current.get(selectedNodeId);
    setSelectedLabelDraft(node?.label ?? "");
  }, [selectedNodeId, nodesRef]);

  const applyView = useCallback(
    (nextView: View) => {
      viewRef.current = nextView;
      setZoomPercent(Math.round(nextView.scale * 100));
      requestRender();
    },
    [viewRef, requestRender]
  );

  const setBoardMode = useCallback((nextMode: string, nextPlacementTypeId: string = "") => {
    setMode(nextMode);
    setPlacementTypeId(nextPlacementTypeId ?? "");
    if (nextMode !== "connect") {
      setPendingConnectionSourceId(null);
      pendingSourcePortRef.current = "default";
    }
  }, []);

  function sendCursor(point: Point) {
    const now = performance.now();
    if (now - lastCursorSentRef.current < 40) return;
    lastCursorSentRef.current = now;
    sendJson(socketRef, { type: "cursor:update", point, workspaceTab: "canvas" });
  }

  function beginPinch() {
    const pair = getPointerPair(pointersRef.current);
    if (!pair) return;

    const [first, second] = pair;
    const midpoint = getMidpoint(first, second);
    pinchRef.current = {
      distance: Math.max(distance(first, second), 1),
      startScale: viewRef.current.scale,
      worldMidpoint: screenToWorld(midpoint, viewRef.current),
    };
  }

  function updatePinch() {
    const pair = getPointerPair(pointersRef.current);
    const pinch = pinchRef.current;
    if (!pair || !pinch) return;

    const [first, second] = pair;
    const midpoint = getMidpoint(first, second);
    const nextScale = clamp(
      (pinch.startScale * distance(first, second)) / pinch.distance,
      0.25,
      4
    );
    applyView({
      x: midpoint.x - pinch.worldMidpoint.x * nextScale,
      y: midpoint.y - pinch.worldMidpoint.y * nextScale,
      scale: nextScale,
    });
  }

  function placeNode(worldPoint: Point) {
    const nodeType = nodeTypes.find((item) => item.id === placementTypeId);
    if (!nodeType) return;

    const nodeId = createClientId("node");
    const position = snapToGrid({
      x: worldPoint.x - nodeType.width / 2,
      y: worldPoint.y - nodeType.height / 2,
    });
    const nextNode: Partial<BoardNode> = {
      id: nodeId,
      typeId: placementTypeId,
      label: nodeType.label,
      x: position.x,
      y: position.y,
      width: nodeType.width,
      height: nodeType.height,
      config: { ...(nodeType.defaultConfig ?? {}) },
      status: "idle",
      output: null,
    };

    nodesRef.current.set(nodeId, nextNode as BoardNode);
    setSelectedNodeId(nodeId);
    requestRender();

    sendJson(socketRef, {
      type: "node:create",
      nodeId,
      nodeTypeId: placementTypeId,
      position,
      label: nodeType.label,
    });

    pushHistory(() => {
      sendJson(socketRef, { type: "node:delete", nodeId });
      nodesRef.current.delete(nodeId);
      setSelectedNodeId(null);
      requestRender();
    });
  }

  function startNodeDrag(node: BoardNode, worldPoint: Point) {
    nodeDragRef.current = {
      nodeId: node.id,
      offset: { x: worldPoint.x - node.x, y: worldPoint.y - node.y },
      startPos: { x: node.x, y: node.y },
      hasMoved: false,
    };
  }

  function moveNode(worldPoint: Point) {
    const dragging = nodeDragRef.current;
    if (!dragging) return;

    const node = nodesRef.current.get(dragging.nodeId);
    if (!node) return;

    const position = snapToGrid({
      x: worldPoint.x - dragging.offset.x,
      y: worldPoint.y - dragging.offset.y,
    });

    nodesRef.current.set(node.id, { ...node, x: position.x, y: position.y });
    if (nodeDragRef.current) nodeDragRef.current.hasMoved = true;
    requestRender();
    sendJson(socketRef, { type: "node:update", nodeId: node.id, position });
  }

  function updateSelectedNodeLabel(label: string) {
    if (!selectedNodeId) return;

    const node = nodesRef.current.get(selectedNodeId);
    if (!node) return;

    nodesRef.current.set(selectedNodeId, { ...node, label });
    requestRender();
    sendJson(socketRef, { type: "node:update", nodeId: selectedNodeId, label });
  }

  function deleteSelectedNode() {
    if (!selectedNodeId) return;
    sendJson(socketRef, { type: "node:delete", nodeId: selectedNodeId });
    setSelectedNodeId(null);
    setPendingConnectionSourceId(null);
  }

  function adjustZoom(multiplier: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const screenPoint: Point = {
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
    };
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

  // Ref-captured versions for use inside event handlers that close over stale state
  const modeRef = useRef(mode);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const pendingConnectionSourceIdRef = useRef(pendingConnectionSourceId);
  const placementTypeIdRef = useRef(placementTypeId);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);
  useEffect(() => { pendingConnectionSourceIdRef.current = pendingConnectionSourceId; }, [pendingConnectionSourceId]);
  useEffect(() => { placementTypeIdRef.current = placementTypeId; }, [placementTypeId]);

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setContextMenu(null);
    if (event.button !== 0) return;

    const screenPoint = getCanvasPoint(canvas, event);
    const worldPoint = screenToWorld(screenPoint, viewRef.current);
    const hitNode = findNodeAtPoint(worldPoint, nodesRef.current);

    setHoverWorldPoint(worldPoint);
    sendCursor(worldPoint);

    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, screenPoint);

    if (pointersRef.current.size >= 2) {
      panRef.current = null;
      nodeDragRef.current = null;
      beginPinch();
      return;
    }

    const currentMode = modeRef.current;
    const currentPendingId = pendingConnectionSourceIdRef.current;

    // ── Placement mode ──────────────────────────────────────────────────────
    if (currentMode === "place") {
      if (event.button === 0 && !hitNode) placeNode(worldPoint);
      return;
    }

    // ── Pending connection: clicking a node completes it (any mode) ─────────
    if (currentPendingId) {
      if (hitNode && hitNode.id !== currentPendingId) {
        setSelectedNodeId(hitNode.id);
        completeConnection(currentPendingId, hitNode.id);
      } else if (!hitNode) {
        cancelConnection();
      }
      return;
    }

    // ── Port-first: clicking an output port starts a connection (any mode) ──
    const portHit = findOutputPortAtPoint(worldPoint);
    if (portHit) {
      startConnection(portHit.node, portHit.portId);
      return;
    }

    // ── Connect mode (node-level fallback, no port click) ───────────────────
    if (currentMode === "connect") {
      if (hitNode) {
        startConnection(hitNode, findClosestOutputPort(hitNode, worldPoint));
      }
      return;
    }

    // ── Select mode ─────────────────────────────────────────────────────────
    if (hitNode) {
      setSelectedNodeId(hitNode.id);
      startNodeDrag(hitNode, worldPoint);
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

    // Always update hover port info and draft target (even when not captured)
    const portHover = findOutputPortAtPoint(worldPoint);
    interactionStateRef.current = {
      ...interactionStateRef.current,
      hoverPortInfo: portHover ? { nodeId: portHover.node.id, portId: portHover.portId } : null,
      connectionDraftTarget: pendingConnectionSourceIdRef.current ? worldPoint : null,
    };

    if (!pointersRef.current.has(event.pointerId)) {
      if (event.pointerType === "mouse") {
        sendCursor(worldPoint);
      }
      requestRender();
      return;
    }

    event.preventDefault();
    pointersRef.current.set(event.pointerId, screenPoint);

    if (pinchRef.current && pointersRef.current.size >= 2) {
      updatePinch();
      return;
    }

    if (nodeDragRef.current) {
      moveNode(worldPoint);
      sendCursor(worldPoint);
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

    sendCursor(worldPoint);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!enabled) return;
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
    }
    if (nodeDragRef.current?.hasMoved) {
      const { nodeId, startPos } = nodeDragRef.current;
      const prevPos = { ...startPos };
      pushHistory(() => {
        const n = nodesRef.current.get(nodeId);
        if (!n) return;
        nodesRef.current.set(nodeId, { ...n, x: prevPos.x, y: prevPos.y });
        sendJson(socketRef, { type: "node:update", nodeId, position: prevPos });
        requestRender();
      });
    }
    nodeDragRef.current = null;
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  }

  // Wheel event with { passive: false }
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

  // Gesture events (Safari trackpad pinch)
  useEffect(() => {
    if (!enabled) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    function handleGestureStart(event: Event) {
      event.preventDefault();
      const screenPoint = getCanvasPoint(canvas!, event as MouseEvent);
      gestureRef.current = {
        startScale: viewRef.current.scale,
        worldPoint: screenToWorld(screenPoint, viewRef.current),
      };
    }

    function handleGestureChange(event: Event) {
      event.preventDefault();
      const gesture = gestureRef.current;
      if (!gesture) return;

      const screenPoint = getCanvasPoint(canvas!, event as MouseEvent);
      const nextScale = clamp(
        gesture.startScale * Number((event as unknown as { scale?: number }).scale || 1),
        0.25,
        4
      );
      applyView({
        x: screenPoint.x - gesture.worldPoint.x * nextScale,
        y: screenPoint.y - gesture.worldPoint.y * nextScale,
        scale: nextScale,
      });
    }

    function handleGestureEnd(event: Event) {
      event.preventDefault();
      gestureRef.current = null;
    }

    canvas.addEventListener("gesturestart", handleGestureStart);
    canvas.addEventListener("gesturechange", handleGestureChange);
    canvas.addEventListener("gestureend", handleGestureEnd);

    return () => {
      canvas.removeEventListener("gesturestart", handleGestureStart);
      canvas.removeEventListener("gesturechange", handleGestureChange);
      canvas.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [applyView, canvasRef, enabled, viewRef]);

  // Keyboard shortcuts
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
        cancelConnection();
        setContextMenu(null);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        const currentSelectedId = selectedNodeIdRef.current;
        if (currentSelectedId) {
          event.preventDefault();
          sendJson(socketRef, { type: "node:delete", nodeId: currentSelectedId });
          setSelectedNodeId(null);
          setPendingConnectionSourceId(null);
        }
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "v" || event.key === "V") {
          setBoardMode("select");
          return;
        }
        if (event.key === "c" || event.key === "C") {
          setMode("connect");
          const currentSelectedId = selectedNodeIdRef.current;
          if (currentSelectedId) {
            const node = nodesRef.current.get(currentSelectedId);
            if (node) startConnection(node, findClosestOutputPort(node, { x: node.x + node.width / 2, y: node.y + node.height }));
          }
          return;
        }
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      if ((event.key === "z" || event.key === "Z") && !event.shiftKey) {
        event.preventDefault();
        applyUndo();
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        adjustZoom(1.15);
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        adjustZoom(0.85);
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        resetZoom();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, setBoardMode, socketRef]);

  // Sync interactionStateRef and trigger render when interaction state changes
  useEffect(() => {
    if (!enabled) return;
    const placementPreview =
      mode === "place" && hoverWorldPoint && placementTypeId
        ? (() => {
            const nodeType = nodeTypes.find((item) => item.id === placementTypeId);
            if (!nodeType) return null;
            return {
              typeId: placementTypeId,
              ...snapToGrid({
                x: hoverWorldPoint.x - nodeType.width / 2,
                y: hoverWorldPoint.y - nodeType.height / 2,
              }),
            };
          })()
        : null;

    interactionStateRef.current = {
      selectedNodeId,
      pendingConnectionSourceId,
      pendingConnectionSourcePort: pendingSourcePortRef.current,
      placementPreview,
      hoverPortInfo: interactionStateRef.current.hoverPortInfo,
      connectionDraftTarget: interactionStateRef.current.connectionDraftTarget,
    };
    requestRender();
  }, [
    enabled,
    mode,
    selectedNodeId,
    pendingConnectionSourceId,
    hoverWorldPoint,
    placementTypeId,
    requestRender,
    interactionStateRef,
    nodeTypes,
  ]);

  return {
    mode,
    placementTypeId,
    selectedNodeId,
    pendingConnectionSourceId,
    selectedLabelDraft,
    zoomPercent,
    contextMenu,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleContextMenu,
    setBoardMode,
    updateSelectedNodeLabel,
    deleteSelectedNode,
    adjustZoom,
    resetZoom,
    setSelectedLabelDraft,
    closeContextMenu,
    connectFromNode,
  };
}
