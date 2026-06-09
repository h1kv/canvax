import { useEffect, useRef, useState, useMemo } from "react";
import { useSocket } from "./hooks/useSocket.js";
import { useRender } from "./hooks/useRender.js";
import { useInteraction } from "./hooks/useInteraction.js";
import { usePlanRender } from "./hooks/usePlanRender.js";
import { usePlanInteraction } from "./hooks/usePlanInteraction.js";
import { TitleBar } from "./components/TitleBar.js";
import { ActivityBar } from "./components/ActivityBar.js";
import { Canvas } from "./components/Canvas.js";
import { PlanCanvas } from "./components/PlanCanvas.js";
import { Sidebar } from "./components/Sidebar.js";
import type { View, InteractionState, BoardNode, WorkspaceTab } from "../types/index.js";
import type { PlanInteractionState } from "./renderPlan.js";

interface WhiteboardProps {
  username: string;
}

export function Whiteboard({ username }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const planCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const planViewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const interactionStateRef = useRef<InteractionState>({
    selectedNodeId: null,
    pendingConnectionSourceId: null,
    pendingConnectionSourcePort: null,
    placementPreview: null,
    hoverPortInfo: null,
    connectionDraftTarget: null,
  });
  const planInteractionStateRef = useRef<PlanInteractionState>({
    selectedNodeId: null,
    placementPreview: null,
    connectionSourceId: null,
    connectionDraftTarget: null,
  });

  const [sidebarTab, setSidebarTab] = useState<string | null>("toolbox");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("canvas");

  const {
    status,
    users,
    nodeTypes,
    nodesRef,
    edgesRef,
    planNodesRef,
    planEdgesRef,
    nodeRunTraceEventsRef,
    selfIdRef,
    socketRef,
    graphVersion,
    planVersion,
    traceVersion,
    chainRunning,
    activeRunId,
    sendWs,
  } =
    useSocket(username);

  const usersRef = useRef(users);
  usersRef.current = users;

  const { requestRender } = useRender({
    canvasRef,
    viewRef,
    nodesRef,
    edgesRef,
    nodeRunTraceEventsRef,
    usersRef,
    selfIdRef,
    interactionStateRef,
    graphVersion,
    traceVersion,
  });

  const { requestRender: requestPlanRender } = usePlanRender({
    canvasRef: planCanvasRef,
    viewRef: planViewRef,
    planNodesRef,
    planEdgesRef,
    usersRef,
    selfIdRef,
    interactionStateRef: planInteractionStateRef,
    planVersion,
  });

  const {
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
  } = useInteraction({
    enabled: workspaceTab === "canvas",
    canvasRef,
    viewRef,
    nodesRef,
    edgesRef,
    socketRef,
    interactionStateRef,
    requestRender,
    nodeTypes,
  });

  const planInteraction = usePlanInteraction({
    enabled: workspaceTab === "plan",
    canvasRef: planCanvasRef,
    viewRef: planViewRef,
    planNodesRef,
    planEdgesRef,
    socketRef,
    interactionStateRef: planInteractionStateRef,
    requestRender: requestPlanRender,
  });

  function handleRun() { sendWs({ type: "chain:run" }); }
  function handleStop() { sendWs({ type: "chain:stop" }); }
  function handleApprove() {
    const paused = Array.from(nodesRef.current.values()).find((n) => n.status === "paused");
    if (paused) sendWs({ type: "review:approve", nodeId: paused.id });
  }
  function handleReject() {
    const paused = Array.from(nodesRef.current.values()).find((n) => n.status === "paused");
    if (paused) sendWs({ type: "review:reject", nodeId: paused.id });
  }
  function handleNodeConfigChange(nodeId: string, patch: Record<string, unknown>) {
    sendWs({ type: "node:config:update", nodeId, config: patch });
  }

  const pausedReviewNode = useMemo<BoardNode | null>(() => {
    for (const node of nodesRef.current.values()) {
      if (node.typeId === "review" && node.status === "paused") return node;
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion]);

  const runningNodeLabel = useMemo<string | null>(() => {
    if (!chainRunning) return null;
    for (const node of nodesRef.current.values()) {
      if (node.status === "running") return node.label || node.typeId;
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainRunning, graphVersion]);

  const chainNodes = useMemo<BoardNode[]>(() => {
    return Array.from(nodesRef.current.values());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion]);

  const traceEvents = useMemo(() => {
    return [...nodeRunTraceEventsRef.current];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceVersion]);

  const selectedNode = selectedNodeId ? (nodesRef.current.get(selectedNodeId) ?? null) : null;
  const selectedTypeName = selectedNode
    ? (nodeTypes.find((t) => t.id === selectedNode.typeId)?.label ?? selectedNode.typeId)
    : null;

  const modeLabel = useMemo(() => {
    if (mode === "connect") return pendingConnectionSourceId ? "Connector — pick target" : "Connector";
    if (mode === "place") {
      const t = nodeTypes.find((t) => t.id === placementTypeId);
      return t ? `Place · ${t.label}` : "Place";
    }
    return "Pointer";
  }, [mode, nodeTypes, pendingConnectionSourceId, placementTypeId]);

  const connectedUsers = Array.from(users.values());
  const planNodes = useMemo(() => {
    return Array.from(planNodesRef.current.values());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planVersion]);

  useEffect(() => {
    const canvas = workspaceTab === "plan" ? planCanvasRef.current : canvasRef.current;
    const render = workspaceTab === "plan" ? requestPlanRender : requestRender;
    if (!canvas) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      render();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [requestPlanRender, requestRender, workspaceTab]);

  function handleTabChange(tab: string) {
    setSidebarTab((prev) => (prev === tab ? null : tab));
  }

  function handleLabelChange(label: string) {
    setSelectedLabelDraft(label);
    if (label) updateSelectedNodeLabel(label);
  }

  return (
    <div className="vsc-shell">
      <TitleBar status={status} userCount={connectedUsers.length} chainRunning={chainRunning} runningNodeLabel={runningNodeLabel} onRun={handleRun} onStop={handleStop} />

      <div className="vsc-surface-tabs" role="tablist" aria-label="Workspace">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "canvas"}
          aria-controls="canvas-panel"
          className={`vsc-surface-tab${workspaceTab === "canvas" ? " active" : ""}`}
          onClick={() => setWorkspaceTab("canvas")}
        >
          Canvas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "plan"}
          aria-controls="plan-panel"
          className={`vsc-surface-tab${workspaceTab === "plan" ? " active" : ""}`}
          onClick={() => setWorkspaceTab("plan")}
        >
          Plan
        </button>
      </div>

      <div className={`vsc-workspace${sidebarTab === null ? " sidebar-collapsed" : ""}`}>
        <div className="vsc-surface-stack">
          <section
            id="canvas-panel"
            role="tabpanel"
            hidden={workspaceTab !== "canvas"}
            className="vsc-surface-panel"
          >
            <Canvas
              canvasRef={canvasRef}
              mode={mode}
              modeLabel={modeLabel}
              zoomPercent={zoomPercent}
              nodeTypes={nodeTypes}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onContextMenu={handleContextMenu}
              onAdjustZoom={adjustZoom}
              onResetZoom={resetZoom}
              pausedReviewNode={pausedReviewNode}
              view={viewRef.current}
              onApprove={handleApprove}
              onReject={handleReject}
              contextMenu={contextMenu}
              onContextMenuClose={closeContextMenu}
              onContextMenuConnect={connectFromNode}
              onContextMenuDelete={(nodeId) => {
                sendWs({ type: "node:delete", nodeId });
                nodesRef.current.delete(nodeId);
                for (const [edgeId, edge] of edgesRef.current.entries()) {
                  if (edge.sourceId === nodeId || edge.targetId === nodeId) {
                    edgesRef.current.delete(edgeId);
                  }
                }
                requestRender();
                closeContextMenu();
              }}
            />
          </section>
          <section
            id="plan-panel"
            role="tabpanel"
            hidden={workspaceTab !== "plan"}
            className="vsc-surface-panel"
          >
            <PlanCanvas
              canvasRef={planCanvasRef}
              mode={planInteraction.mode}
              placementKind={planInteraction.placementKind}
              modeLabel={planInteraction.modeLabel}
              zoomPercent={planInteraction.zoomPercent}
              onPointerDown={planInteraction.handlePointerDown}
              onPointerMove={planInteraction.handlePointerMove}
              onPointerUp={planInteraction.handlePointerUp}
              onAdjustZoom={planInteraction.adjustZoom}
              onResetZoom={planInteraction.resetZoom}
              onSetMode={planInteraction.setBoardMode}
            />
          </section>
        </div>

        <Sidebar
          workspaceTab={workspaceTab}
          sidebarTab={sidebarTab}
          mode={mode}
          nodeTypes={nodeTypes}
          placementTypeId={placementTypeId}
          pendingConnectionSourceId={pendingConnectionSourceId}
          selectedNode={selectedNode}
          selectedTypeName={selectedTypeName}
          selectedLabelDraft={selectedLabelDraft}
          onSetMode={setBoardMode}
          onLabelChange={handleLabelChange}
          onDeleteNode={deleteSelectedNode}
          onNodeConfigChange={handleNodeConfigChange}
          onApprove={handleApprove}
          onReject={handleReject}
          chainNodes={chainNodes}
          chainRunning={chainRunning}
          traceEvents={traceEvents}
          activeRunId={activeRunId}
          planNodes={planNodes}
          planMode={planInteraction.mode}
          planPlacementKind={planInteraction.placementKind}
          selectedPlanNode={planInteraction.selectedNode}
          socketRef={socketRef}
          onSetPlanMode={planInteraction.setBoardMode}
          onPlanNodeUpdate={planInteraction.updateSelectedNode}
          onPlanNodeDelete={planInteraction.deleteSelectedNode}
          onPlanNodeConnect={planInteraction.connectFromSelected}
        />

        <ActivityBar sidebarTab={sidebarTab} onTabChange={handleTabChange} />
      </div>

      <footer className="vsc-statusbar">
        <div className="vsc-statusbar-left">
          <span className="vsc-sitem">
            <span className={`vsc-status-pill ${status}`} />
            {status}
          </span>
          <span className="vsc-ssep" />
          <span className="vsc-sitem">{workspaceTab === "plan" ? planInteraction.modeLabel : modeLabel}</span>
        </div>
        <div className="vsc-statusbar-right">
          <span className="vsc-sitem">
            {workspaceTab === "plan" ? `${planNodesRef.current.size} plan blocks` : `${nodesRef.current.size} nodes`}
          </span>
          <span className="vsc-ssep" />
          <span className="vsc-sitem">{connectedUsers.length} online</span>
          <span className="vsc-ssep" />
          <button type="button" className="vsc-sitem vsc-sitem-btn" onClick={() => workspaceTab === "plan" ? planInteraction.adjustZoom(1.15) : adjustZoom(1.15)} aria-label="Zoom in">+</button>
          <button type="button" className="vsc-sitem vsc-sitem-btn" onClick={() => workspaceTab === "plan" ? planInteraction.resetZoom() : resetZoom()} title="Reset zoom">
            {workspaceTab === "plan" ? planInteraction.zoomPercent : zoomPercent}%
          </button>
          <button type="button" className="vsc-sitem vsc-sitem-btn" onClick={() => workspaceTab === "plan" ? planInteraction.adjustZoom(0.85) : adjustZoom(0.85)} aria-label="Zoom out">−</button>
        </div>
      </footer>
    </div>
  );
}
