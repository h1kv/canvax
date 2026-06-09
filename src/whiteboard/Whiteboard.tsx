import { useEffect, useRef, useState, useMemo } from "react";
import { useSocket } from "./hooks/useSocket.js";
import { useRender } from "./hooks/useRender.js";
import { useInteraction } from "./hooks/useInteraction.js";
import { TitleBar } from "./components/TitleBar.js";
import { ActivityBar } from "./components/ActivityBar.js";
import { Canvas } from "./components/Canvas.js";
import { PlanCanvas } from "./components/PlanCanvas.js";
import { Sidebar } from "./components/Sidebar.js";
import { SkillsPanel } from "./components/SkillsPanel.js";
import type { View, InteractionState, BoardNode, WorkspaceTab } from "../types/index.js";

interface WhiteboardProps {
  username: string;
}

export function Whiteboard({ username }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const interactionStateRef = useRef<InteractionState>({
    selectedNodeId: null,
    pendingConnectionSourceId: null,
    pendingConnectionSourcePort: null,
    placementPreview: null,
    hoverPortInfo: null,
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
    nodeRunTraceEventsRef,
    selfIdRef,
    socketRef,
    graphVersion,
    traceVersion,
    chainRunning,
    activeRunId,
    sendWs,
    planElements,
    sendPlanUpdate,
    pendingApprovals,
    approveToolCall,
    denyToolCall,
  } =
    useSocket(username);

  const usersRef = useRef(users);
  usersRef.current = users;

  const pendingApprovalNodeIdsRef = useRef<Set<string>>(new Set());
  pendingApprovalNodeIdsRef.current = useMemo(() => {
    const nodeIds = new Set<string>();
    for (const approval of pendingApprovals.values()) {
      if (approval.nodeId) nodeIds.add(approval.nodeId);
    }
    return nodeIds;
  }, [pendingApprovals]);

  const { requestRender } = useRender({
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

  useEffect(() => {
    if (workspaceTab !== "canvas") return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      requestRender();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [requestRender, workspaceTab]);

  function handleTabChange(tab: string) {
    setSidebarTab((prev) => (prev === tab ? null : tab));
  }

  function handleLabelChange(label: string) {
    setSelectedLabelDraft(label);
    if (label) updateSelectedNodeLabel(label);
  }

  return (
    <div className="vsc-shell">
      {status === "connecting" && (
        <div className="dispatch-loading" aria-live="polite" aria-label="Connecting to DISPATCH.AI">
          <div className="dispatch-loading-text">DISPATCH.AI</div>
        </div>
      )}
      <TitleBar
        status={status}
        userCount={connectedUsers.length}
        chainRunning={chainRunning}
        runningNodeLabel={runningNodeLabel}
        workspaceTab={workspaceTab}
        onRun={handleRun}
        onStop={handleStop}
        onWorkspaceTabChange={setWorkspaceTab}
      />

      <div className={`vsc-workspace${sidebarTab === null ? " sidebar-collapsed" : ""}${workspaceTab === "skills" ? " skills-active" : ""}`}>
        <div className="vsc-surface-stack">
          {workspaceTab === "skills" && (
            <section
              id="skills-panel"
              role="tabpanel"
              className="vsc-surface-panel"
            >
              <SkillsPanel socketRef={socketRef} />
            </section>
          )}
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
              elements={planElements}
              onUpdate={sendPlanUpdate}
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
          onApproveToolCall={approveToolCall}
          onDenyToolCall={denyToolCall}
          pendingApprovals={pendingApprovals}
          chainNodes={chainNodes}
          chainRunning={chainRunning}
          traceEvents={traceEvents}
          activeRunId={activeRunId}
          socketRef={socketRef}
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
          <span className="vsc-sitem">{modeLabel}</span>
        </div>
        <div className="vsc-statusbar-right">
          <span className="vsc-sitem">
            {nodesRef.current.size} nodes
          </span>
          <span className="vsc-ssep" />
          <span className="vsc-sitem">{connectedUsers.length} online</span>
          <span className="vsc-ssep" />
          <button type="button" className="vsc-sitem vsc-sitem-btn" onClick={() => adjustZoom(1.15)} aria-label="Zoom in">+</button>
          <button type="button" className="vsc-sitem vsc-sitem-btn" onClick={() => resetZoom()} title="Reset zoom">
            {zoomPercent}%
          </button>
          <button type="button" className="vsc-sitem vsc-sitem-btn" onClick={() => adjustZoom(0.85)} aria-label="Zoom out">−</button>
        </div>
      </footer>
    </div>
  );
}
