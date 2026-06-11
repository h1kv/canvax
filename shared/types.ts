// Shared contracts for the Node V2 canvas.

export type WorkspaceTab = "canvas" | "plan" | "conversate";

export type NodeV2Type =
  | "initialiser"
  | "investigate"
  | "plan"
  | "design"
  | "create"
  | "evaluate"
  | "doc"
  | "apply"
  | "context"
  | "review";

export type EdgeV2Kind = "flow" | "midput" | "reject";
export type NodeStatus = "idle" | "running" | "done" | "error";

export interface Point { x: number; y: number; }
export interface View { x: number; y: number; scale: number; }

export interface NodeV2Config {
  workspacePath?: string; // initialiser
  taskPrompt?: string;    // SDLC nodes
  content?: string;       // context node
}

export interface NodeV2 {
  id: string;
  type: NodeV2Type;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  config: NodeV2Config;
  status: NodeStatus;
  output: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface EdgeV2 {
  id: string;
  sourceId: string;
  targetId: string;
  kind: EdgeV2Kind;
  createdBy: string;
  createdAt: number;
}

export type ChatGraphOperation =
  | {
      op: "create_node";
      tempId: string;
      nodeType: NodeV2Type;
      position?: Point;
      title?: string;
      config?: Partial<NodeV2Config>;
    }
  | { op: "update_node"; nodeId: string; title?: string; config?: Partial<NodeV2Config> }
  | { op: "delete_node"; nodeId: string }
  | { op: "create_edge"; tempId: string; sourceId: string; targetId: string; kind: EdgeV2Kind }
  | { op: "delete_edge"; edgeId: string; sourceId?: string; targetId?: string; kind?: EdgeV2Kind }
  | { op: "delete_edge_between"; sourceId: string; targetId: string; kind?: EdgeV2Kind }
  | {
      op: "insert_node_between";
      tempId: string;
      nodeType: NodeV2Type;
      sourceId: string;
      targetId: string;
      kind?: EdgeV2Kind;
      title?: string;
      config?: Partial<NodeV2Config>;
    };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  pendingOps?: ChatGraphOperation[];
  pendingSummary?: string;
  error?: string;
  applied?: boolean;
  command?: string;
  commandNodeId?: string | null;
}

export interface ChatTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface NodeDefinitionV2 {
  type: NodeV2Type;
  label: string;
  defaultTitle: string;
  width: number;
  height: number;
  accent: string;
  hasFlowIn: boolean;
  hasFlowOut: boolean;
  hasMidputIn: boolean;
  hasMidputOut: boolean;
  hasRejectOut?: boolean;
  isSDLC: boolean;
  defaultConfig: NodeV2Config;
}

export interface MaterializeFilePlan {
  relativePath: string;
  absolutePath: string;
  action: "create" | "modify" | "skip";
  exists: boolean;
  bytes: number;
  diff?: string;
  warnings: string[];
}

export interface MaterializeWritePlan {
  workspacePath: string;
  files: MaterializeFilePlan[];
  warnings: string[];
  errors: string[];
  requiresApproval: boolean;
}

export interface ReviewRequest {
  reviewId: string;
  nodeId: string;
  title: string;
  content: string;
}


export interface SkillMeta {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: string[];
  description?: string;
}

export interface LoadedSkill {
  systemPrompt: string;
  meta: SkillMeta;
}

export interface WorkspaceStateV2 {
  version: 2;
  nodes: NodeV2[];
  edges: EdgeV2[];
  planElements: string;
  chatMessages: ChatTranscriptMessage[];
}

export interface BoardUser {
  id: string;
  name: string;
  color: string;
  cursor: Point | null;
  cursorWorkspace?: WorkspaceTab;
}

export interface InteractionState {
  selectedNodeId: string | null;
  placementPreview: (Point & { type: NodeV2Type }) | null;
  pendingConnectionSourceId: string | null;
  pendingConnectionKind: EdgeV2Kind | null;
  connectionDraftTarget: Point | null;
}
