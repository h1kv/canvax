// Shared types used by both the server (ws messages, execution) and the client (rendering, UI).

export type NodeShape = "rect";

export type NodeCategory = "start" | "ai-step" | "review" | "control" | "tool" | "memory" | "context";

export type NodeStatus = "idle" | "running" | "done" | "error" | "paused";

export type WorkspaceTab = "canvas" | "plan";

export type EdgeKind = "flow" | "context";

export type NodeRunTraceKind =
  | "chain:started"
  | "chain:completed"
  | "chain:stopped"
  | "node:started"
  | "node:status"
  | "node:input"
  | "node:output"
  | "node:model"
  | "node:tool-call"
  | "node:tool-result"
  | "node:tool-error"
  | "review:waiting"
  | "review:decision"
  | "ledger:fact-added"
  | "artifact:created"
  | "evaluation:failed"
  | "repair:started"
  | "repair:completed"
  | "node:error";

export interface NodeRunTraceEvent {
  id: string;
  runId: string;
  nodeId: string | null;
  seq: number;
  at: number;
  kind: NodeRunTraceKind;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export type PlanNodeKind =
  | "note"
  | "task"
  | "decision"
  | "risk"
  | "flow-step"
  | "proposed-agent"
  | "proposed-tool"
  | "approval-point"
  | "context";

export interface OutputPort {
  id: string;
  label: string;
}

export interface NodeTypeConfig {
  id: string;
  label: string;
  description: string;
  shape: NodeShape;
  width: number;
  height: number;
  accent: string;
  fill: string;
  border: string;
  text: string;
  category: NodeCategory;
  outputPorts: OutputPort[];
  defaultConfig: Record<string, unknown>;
}

export interface BoardNode {
  id: string;
  typeId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  createdBy: string;
  createdAt: number;
  config: Record<string, unknown>;
  status: NodeStatus;
  output: string | null;
}

export interface BoardEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourcePort: string;
  edgeKind?: EdgeKind;
  createdBy: string;
  createdAt: number;
}

export interface LedgerSource {
  id: string;
  nodeId: string;
  kind: "context" | "tool" | "model" | "artifact";
  label: string;
  url?: string;
}

export interface LedgerFact {
  id: string;
  nodeId: string;
  sourceId?: string;
  kind: "context" | "research" | "output" | "artifact" | "evaluation";
  title: string;
  content: string;
  confidence?: "low" | "medium" | "high";
  createdAt: number;
}

export interface ArtifactRecord {
  id: string;
  nodeId: string;
  title: string;
  content: string;
  path?: string;
  mimeType?: string;
  createdAt: number;
}

export interface EvaluationVerdict {
  id: string;
  nodeId: string;
  artifactId?: string;
  verdict: "pass" | "fail" | "unknown";
  issues: string[];
  createdAt: number;
}

export interface RepairRecord {
  id: string;
  nodeId: string;
  artifactId?: string;
  round: number;
  issues: string[];
  createdAt: number;
}

export interface RunLedger {
  id: string;
  taskGoal: string;
  startedAt: number;
  completedAt?: number;
  sources: LedgerSource[];
  facts: LedgerFact[];
  nodeOutputs: Array<{ nodeId: string; role?: string; label: string; output: string; createdAt: number }>;
  artifacts: ArtifactRecord[];
  evaluations: EvaluationVerdict[];
  repairs: RepairRecord[];
}

export interface WorkspaceState {
  version: 1;
  nodes: BoardNode[];
  edges: BoardEdge[];
  planElements: string;
  workspaceMemory: Record<string, string>;
  runHistory: RunLedger[];
  artifacts: ArtifactRecord[];
}

export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  title: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  createdBy: string;
  createdAt: number;
  data: Record<string, unknown>;
}

export interface PlanEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  createdBy: string;
  createdAt: number;
}

export interface BoardUser {
  id: string;
  name: string;
  color: string;
  cursor: Point | null;
  cursorWorkspace?: WorkspaceTab;
}

export interface Point {
  x: number;
  y: number;
}

export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface GraphState {
  nodes: Map<string, BoardNode>;
  edges: Map<string, BoardEdge>;
}

export interface PlanGraphState {
  nodes: Map<string, PlanNode>;
  edges: Map<string, PlanEdge>;
}

export interface InteractionState {
  selectedNodeId: string | null;
  pendingConnectionSourceId: string | null;
  pendingConnectionSourcePort: string | null;
  placementPreview: (Point & { typeId: string }) | null;
  hoverPortInfo: { nodeId: string; portId: string } | null;
  connectionDraftTarget: Point | null;
}
