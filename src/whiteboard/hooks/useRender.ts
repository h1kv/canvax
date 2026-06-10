import { useCallback, useEffect, useRef } from "react";
import { renderBoard } from "../render.js";
import type { GraphPreviewState } from "../render.js";
import type { BoardUser, EdgeV2, InteractionState, NodeV2, View } from "../../types/index.js";

export type { GraphPreviewState } from "../render.js";

export interface UseRenderParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewRef: React.MutableRefObject<View>;
  nodesRef: React.MutableRefObject<Map<string, NodeV2>>;
  edgesRef: React.MutableRefObject<Map<string, EdgeV2>>;
  usersRef: React.MutableRefObject<Map<string, BoardUser>>;
  selfIdRef: React.MutableRefObject<string | null>;
  interactionStateRef: React.MutableRefObject<InteractionState>;
  graphVersion: number;
  graphPreview?: GraphPreviewState | null;
}

export function useRender(params: UseRenderParams): { requestRender: () => void } {
  const {
    canvasRef,
    viewRef,
    nodesRef,
    edgesRef,
    usersRef,
    selfIdRef,
    interactionStateRef,
    graphVersion,
    graphPreview,
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
        graphPreview
      );
    });
  }, [canvasRef, viewRef, nodesRef, edgesRef, usersRef, selfIdRef, interactionStateRef, graphPreview]);

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
  }, [graphVersion, graphPreview, requestRender]);

  return { requestRender };
}
