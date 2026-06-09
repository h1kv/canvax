import { useCallback, useEffect, useRef } from "react";
import { renderBoard } from "../render.js";
import type { View, BoardNode, BoardEdge, BoardUser, InteractionState, NodeRunTraceEvent } from "../../types/index.js";

export interface UseRenderParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewRef: React.MutableRefObject<View>;
  nodesRef: React.MutableRefObject<Map<string, BoardNode>>;
  edgesRef: React.MutableRefObject<Map<string, BoardEdge>>;
  nodeRunTraceEventsRef: React.MutableRefObject<NodeRunTraceEvent[]>;
  usersRef: React.MutableRefObject<Map<string, BoardUser>>;
  selfIdRef: React.MutableRefObject<string | null>;
  interactionStateRef: React.MutableRefObject<InteractionState>;
  pendingApprovalNodeIdsRef: React.MutableRefObject<Set<string>>;
  graphVersion: number;
  traceVersion: number;
}

export interface UseRenderResult {
  requestRender: () => void;
}

export function useRender(params: UseRenderParams): UseRenderResult {
  const {
    canvasRef,
    viewRef,
    nodesRef,
    edgesRef,
    nodeRunTraceEventsRef,
    usersRef,
    selfIdRef,
    interactionStateRef,
    pendingApprovalNodeIdsRef,
    graphVersion,
    traceVersion,
  } = params;

  const rafRef = useRef<number | null>(null);

  const requestRender = useCallback(() => {
    if (rafRef.current) return;

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");

      if (!canvas || !ctx) return;

      renderBoard(
        ctx,
        canvas,
        viewRef.current,
        usersRef.current,
        selfIdRef.current,
        { nodes: nodesRef.current, edges: edgesRef.current },
        interactionStateRef.current,
        nodeRunTraceEventsRef.current,
        pendingApprovalNodeIdsRef.current
      );
    });
  }, [canvasRef, viewRef, nodesRef, edgesRef, nodeRunTraceEventsRef, usersRef, selfIdRef, interactionStateRef, pendingApprovalNodeIdsRef]);

  // Keep canvas pixel size in sync with CSS size (HiDPI)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    function updateCanvasSize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      requestRender();
    }

    const resizeObserver = new ResizeObserver(updateCanvasSize);
    resizeObserver.observe(canvas);
    updateCanvasSize();

    return () => resizeObserver.disconnect();
  }, [canvasRef, requestRender]);

  // Re-render whenever graph or run trace changes
  useEffect(() => {
    requestRender();
  }, [graphVersion, traceVersion, requestRender]);

  return { requestRender };
}
