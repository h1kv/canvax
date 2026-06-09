import { useCallback, useEffect, useRef } from "react";
import { renderPlanBoard, type PlanInteractionState } from "../renderPlan.js";
import type { BoardUser, PlanEdge, PlanNode, View } from "../../types/index.js";

export interface UsePlanRenderParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewRef: React.MutableRefObject<View>;
  planNodesRef: React.MutableRefObject<Map<string, PlanNode>>;
  planEdgesRef: React.MutableRefObject<Map<string, PlanEdge>>;
  usersRef: React.MutableRefObject<Map<string, BoardUser>>;
  selfIdRef: React.MutableRefObject<string | null>;
  interactionStateRef: React.MutableRefObject<PlanInteractionState>;
  planVersion: number;
}

export function usePlanRender(params: UsePlanRenderParams): { requestRender: () => void } {
  const {
    canvasRef,
    viewRef,
    planNodesRef,
    planEdgesRef,
    usersRef,
    selfIdRef,
    interactionStateRef,
    planVersion,
  } = params;
  const rafRef = useRef<number | null>(null);

  const requestRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      renderPlanBoard(
        ctx,
        canvas,
        viewRef.current,
        usersRef.current,
        selfIdRef.current,
        { nodes: planNodesRef.current, edges: planEdgesRef.current },
        interactionStateRef.current
      );
    });
  }, [canvasRef, viewRef, planNodesRef, planEdgesRef, usersRef, selfIdRef, interactionStateRef]);

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

  useEffect(() => {
    requestRender();
  }, [planVersion, requestRender]);

  return { requestRender };
}
