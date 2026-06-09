import type { PlanNode, PlanNodeKind } from "../../types/index.js";

const PLAN_KINDS: Array<{ kind: PlanNodeKind; label: string; description: string }> = [
  { kind: "note", label: "Note", description: "Freeform planning notes." },
  { kind: "task", label: "Task", description: "A concrete work item." },
  { kind: "decision", label: "Decision", description: "A choice or tradeoff." },
  { kind: "risk", label: "Risk", description: "An assumption or failure mode." },
  { kind: "flow-step", label: "Flow Step", description: "A process step." },
  { kind: "proposed-agent", label: "Proposed Agent", description: "A future workflow node." },
  { kind: "proposed-tool", label: "Proposed Tool", description: "A future tool call." },
  { kind: "approval-point", label: "Approval Point", description: "A future gate." },
  { kind: "context", label: "Context", description: "A planning context source." },
];

interface PlanSidebarPanelProps {
  planNodes: PlanNode[];
  selectedPlanNode: PlanNode | null;
  mode: string;
  placementKind: PlanNodeKind;
  onSetMode: (mode: "select" | "place" | "connect", kind?: PlanNodeKind) => void;
  onUpdateSelected: (patch: Record<string, unknown>) => void;
  onDeleteSelected: () => void;
  onConnectSelected: () => void;
}

export function PlanSidebarPanel({
  planNodes,
  selectedPlanNode,
  mode,
  placementKind,
  onSetMode,
  onUpdateSelected,
  onDeleteSelected,
  onConnectSelected,
}: PlanSidebarPanelProps) {
  return (
    <>
      <div className="vsc-sidebar-title">Plan Workspace</div>
      <p className="plan-sidebar-copy">
        Sketch notes, flowcharts, risks, and proposed agents before promoting anything into the executable canvas.
      </p>

      <div className="vsc-section-hdr">Modes</div>
      <div className="vsc-list">
        <button
          type="button"
          className={`vsc-list-item${mode === "select" ? " active" : ""}`}
          aria-pressed={mode === "select"}
          onClick={() => onSetMode("select")}
        >
          <span className="vsc-list-label">Pointer</span>
        </button>
        <button
          type="button"
          className={`vsc-list-item${mode === "connect" ? " active" : ""}`}
          aria-pressed={mode === "connect"}
          onClick={() => onSetMode("connect")}
        >
          <span className="vsc-list-label">Connect</span>
        </button>
      </div>

      <div className="vsc-section-hdr">Planning Blocks</div>
      <div className="vsc-list">
        {PLAN_KINDS.map((item) => (
          <button
            key={item.kind}
            type="button"
            className={`vsc-list-item${mode === "place" && placementKind === item.kind ? " active" : ""}`}
            aria-pressed={mode === "place" && placementKind === item.kind}
            onClick={() => onSetMode("place", item.kind)}
            title={item.description}
          >
            <span className="vsc-list-label">{item.label}</span>
          </button>
        ))}
      </div>

      <div className="vsc-divider" />
      <div className="vsc-section-hdr">Summary</div>
      <div className="plan-summary">
        <span>{planNodes.length} plan block{planNodes.length === 1 ? "" : "s"}</span>
      </div>

      {selectedPlanNode && (
        <>
          <div className="vsc-divider" />
          <div className="vsc-section-hdr">Properties</div>
          <div className="vsc-cfg-panel">
            <div className="vsc-cfg-field">
              <label className="vsc-cfg-label" htmlFor="plan-node-kind">Kind</label>
              <select
                id="plan-node-kind"
                className="vsc-cfg-select"
                value={selectedPlanNode.kind}
                onChange={(e) => onUpdateSelected({ kind: e.target.value })}
              >
                {PLAN_KINDS.map((item) => (
                  <option key={item.kind} value={item.kind}>{item.label}</option>
                ))}
              </select>
            </div>
            <div className="vsc-cfg-field">
              <label className="vsc-cfg-label" htmlFor="plan-node-title">Title</label>
              <input
                id="plan-node-title"
                className="vsc-cfg-select"
                type="text"
                value={selectedPlanNode.title}
                onChange={(e) => onUpdateSelected({ title: e.target.value })}
              />
            </div>
            <div className="vsc-cfg-field">
              <label className="vsc-cfg-label" htmlFor="plan-node-body">Body</label>
              <textarea
                id="plan-node-body"
                className="vsc-cfg-textarea"
                rows={6}
                value={selectedPlanNode.body}
                onChange={(e) => onUpdateSelected({ body: e.target.value })}
              />
            </div>
          </div>
          <button type="button" className="vsc-list-item" onClick={onConnectSelected}>
            <span className="vsc-list-label">Connect from selected</span>
          </button>
          <button type="button" className="vsc-prop-delete" onClick={onDeleteSelected}>
            Delete plan block
          </button>
        </>
      )}
    </>
  );
}
