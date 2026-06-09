import type { PlanNodeKind } from "../../types/index.js";

interface PlanCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  modeLabel: string;
  zoomPercent: number;
  mode: string;
  placementKind: PlanNodeKind;
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onAdjustZoom: (factor: number) => void;
  onResetZoom: () => void;
  onSetMode: (mode: "select" | "place" | "connect", kind?: PlanNodeKind) => void;
}

const QUICK_KINDS: Array<{ kind: PlanNodeKind; label: string }> = [
  { kind: "note", label: "Note" },
  { kind: "task", label: "Task" },
  { kind: "decision", label: "Decision" },
  { kind: "risk", label: "Risk" },
];

export function PlanCanvas({
  canvasRef,
  modeLabel,
  zoomPercent,
  mode,
  placementKind,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onAdjustZoom,
  onResetZoom,
  onSetMode,
}: PlanCanvasProps) {
  return (
    <main className="vsc-editor">
      <canvas
        ref={canvasRef}
        className={`vsc-canvas mode-${mode}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
        aria-label="Plan workspace canvas. Use the Plan toolbar or sidebar to place and connect planning blocks."
        tabIndex={0}
      >
        Plan workspace canvas. Use the Plan toolbar or sidebar to create notes, tasks, decisions, risks, and flow steps.
      </canvas>

      <div className="plan-toolbar" aria-label="Plan workspace tools">
        <button
          type="button"
          className={`plan-tool-btn${mode === "select" ? " active" : ""}`}
          aria-pressed={mode === "select"}
          onClick={() => onSetMode("select")}
        >
          Pointer
        </button>
        <button
          type="button"
          className={`plan-tool-btn${mode === "connect" ? " active" : ""}`}
          aria-pressed={mode === "connect"}
          onClick={() => onSetMode("connect")}
        >
          Connect
        </button>
        {QUICK_KINDS.map((item) => (
          <button
            key={item.kind}
            type="button"
            className={`plan-tool-btn${mode === "place" && placementKind === item.kind ? " active" : ""}`}
            aria-pressed={mode === "place" && placementKind === item.kind}
            onClick={() => onSetMode("place", item.kind)}
          >
            {item.label}
          </button>
        ))}
      </div>

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
