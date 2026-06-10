import type { ContextMenuState } from "../hooks/useInteraction.js";

interface CanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mode: string;
  modeLabel: string;
  zoomPercent: number;
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onAdjustZoom: (factor: number) => void;
  onResetZoom: () => void;
  contextMenu: ContextMenuState | null;
  onContextMenuClose: () => void;
  onContextMenuDelete: (nodeId: string) => void;
}

export function Canvas({
  canvasRef,
  mode,
  modeLabel,
  zoomPercent,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
  onAdjustZoom,
  onResetZoom,
  contextMenu,
  onContextMenuClose,
  onContextMenuDelete,
}: CanvasProps) {
  return (
    <main className="vsc-editor">
      <canvas
        ref={canvasRef}
        className={`vsc-canvas mode-${mode}`}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {contextMenu && (
        <>
          <div className="vsc-ctx-backdrop" onClick={onContextMenuClose} />
          <div
            className="vsc-ctx-menu"
            style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
          >
            {contextMenu.nodeId ? (
              <button
                type="button"
                className="vsc-ctx-item vsc-ctx-item--danger"
                onClick={() => onContextMenuDelete(contextMenu.nodeId!)}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <polyline points="3,4 13,4" />
                  <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
                  <path d="M4 4l1 9h6l1-9" />
                </svg>
                Delete node
              </button>
            ) : (
              <button type="button" className="vsc-ctx-item" onClick={onContextMenuClose}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M1.5 1L7 13.5l2.2-5.3L14.5 6z" />
                </svg>
                Pointer mode
              </button>
            )}
          </div>
        </>
      )}

      <div className="vsc-hint" aria-hidden="true">
        <span className="vsc-hint-mode">{modeLabel}</span>
        <span className="vsc-hint-sep" />
        <span className="vsc-hint-zoom">{zoomPercent}%</span>
      </div>
      <div className="vsc-zoom" aria-label="Zoom controls">
        <button type="button" className="vsc-zoom-btn" aria-label="Zoom in" onClick={() => onAdjustZoom(1.15)}>+</button>
        <button type="button" className="vsc-zoom-btn" aria-label="Reset zoom" onClick={onResetZoom} title="Reset zoom">⟳</button>
        <button type="button" className="vsc-zoom-btn" aria-label="Zoom out" onClick={() => onAdjustZoom(0.85)}>−</button>
      </div>
    </main>
  );
}
