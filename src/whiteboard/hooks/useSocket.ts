import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BoardUser,
  ChatTranscriptMessage,
  EdgeV2,
  MaterializeWritePlan,
  NodeV2,
  NodeStatus,
  ReviewRequest,
  SkillMeta,
} from "../../types/index.js";

export type TerminalLevel = "info" | "warn" | "error" | "done";
export interface TerminalEntry {
  id: number;
  ts: number;
  level: TerminalLevel;
  msg: string;
}

function getSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function sendJson(socketRef: React.MutableRefObject<WebSocket | null>, message: unknown): void {
  if (socketRef.current?.readyState === WebSocket.OPEN) {
    socketRef.current.send(JSON.stringify(message));
  }
}

export interface UseSocketResult {
  status: string;
  users: Map<string, BoardUser>;
  nodesRef: React.MutableRefObject<Map<string, NodeV2>>;
  edgesRef: React.MutableRefObject<Map<string, EdgeV2>>;
  selfIdRef: React.MutableRefObject<string | null>;
  socketRef: React.MutableRefObject<WebSocket | null>;
  graphVersion: number;
  chainRunning: boolean;
  terminalLogs: TerminalEntry[];
  clearTerminal: () => void;
  nodeErrors: Map<string, string>;
  materializePlan: MaterializeWritePlan | null;
  reviewRequest: ReviewRequest | null;
  chatMessages: ChatTranscriptMessage[];
  chatHydrationVersion: number;
  sendWs: (msg: unknown) => void;
  planElements: string;
  sendPlanUpdate: (elements: string) => void;
  hostedSiteUrl: string | null;
  skillsMeta: Record<string, SkillMeta>;
}

export function useSocket(username: string): UseSocketResult {
  const socketRef = useRef<WebSocket | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const nodesRef = useRef<Map<string, NodeV2>>(new Map());
  const edgesRef = useRef<Map<string, EdgeV2>>(new Map());
  const usersRef = useRef<Map<string, BoardUser>>(new Map());

  const [status, setStatus] = useState("connecting");
  const [users, setUsers] = useState<Map<string, BoardUser>>(new Map());
  const [graphVersion, setGraphVersion] = useState(0);
  const [planElements, setPlanElements] = useState("[]");
  const [chainRunning, setChainRunning] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<TerminalEntry[]>([]);
  const [nodeErrors, setNodeErrors] = useState<Map<string, string>>(new Map());
  const [materializePlan, setMaterializePlan] = useState<MaterializeWritePlan | null>(null);
  const materializePlanRef = useRef<MaterializeWritePlan | null>(null);
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | null>(null);
  const [hostedSiteUrl, setHostedSiteUrl] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatTranscriptMessage[]>([]);
  const [chatHydrationVersion, setChatHydrationVersion] = useState(0);
  const [skillsMeta, setSkillsMeta] = useState<Record<string, SkillMeta>>({});
  const logIdRef = useRef(0);

  function bumpGraph() { setGraphVersion((v) => v + 1); }

  function pushLog(level: TerminalLevel, msg: string) {
    const entry: TerminalEntry = { id: ++logIdRef.current, ts: Date.now(), level, msg };
    setTerminalLogs((prev) => [...prev.slice(-299), entry]);
  }

  const clearTerminal = useCallback(() => setTerminalLogs([]), []);

  useEffect(() => {
    const socket = new WebSocket(getSocketUrl());
    socketRef.current = socket;
    setStatus("connecting");

    socket.addEventListener("open", () => {
      setStatus("connected");
      sendJson(socketRef, { type: "join", name: username });
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (message.type) {
        case "init": {
          selfIdRef.current = message.selfId as string;
          usersRef.current = new Map(((message.users as BoardUser[]) || []).map((u) => [u.id, u]));
          nodesRef.current = new Map(((message.nodes as NodeV2[]) || []).map((n) => [n.id, n]));
          edgesRef.current = new Map(((message.edges as EdgeV2[]) || []).map((e) => [e.id, e]));
          setPlanElements(typeof message.planElements === "string" ? message.planElements : "[]");
          setChatMessages(Array.isArray(message.chatMessages) ? message.chatMessages as ChatTranscriptMessage[] : []);
          if (message.skillsMeta && typeof message.skillsMeta === "object") {
            setSkillsMeta(message.skillsMeta as Record<string, SkillMeta>);
          }
          setChatHydrationVersion((v) => v + 1);
          setUsers(new Map(usersRef.current));
          bumpGraph();
          return;
        }

        case "user:joined": {
          const user = message.user as BoardUser;
          usersRef.current.set(user.id, user);
          setUsers(new Map(usersRef.current));
          return;
        }

        case "user:left": {
          usersRef.current.delete(message.userId as string);
          setUsers(new Map(usersRef.current));
          bumpGraph();
          return;
        }

        case "cursor:update": {
          const user = usersRef.current.get(message.userId as string);
          if (!user) return;
          usersRef.current.set(message.userId as string, {
            ...user,
            cursor: message.point as { x: number; y: number },
            cursorWorkspace: message.workspaceTab === "plan" ? "plan" : "canvas",
          });
          setUsers(new Map(usersRef.current));
          bumpGraph();
          return;
        }

        case "node:created":
        case "node:updated": {
          const node = message.node as NodeV2;
          nodesRef.current.set(node.id, node);
          bumpGraph();
          return;
        }

        case "node:status": {
          const nodeId = message.nodeId as string;
          const existing = nodesRef.current.get(nodeId);
          if (existing) {
            const newStatus = message.status as NodeStatus;
            nodesRef.current.set(nodeId, {
              ...existing,
              status: newStatus,
              output: message.output as string | null,
            });
            if (newStatus === "running") pushLog("info", `Running: ${existing.title}`);
            if (newStatus === "done") pushLog("done", `Done: ${existing.title}`);
            if (newStatus === "error") {
              const errMsg = message.output as string;
              pushLog("error", `Error in "${existing.title}": ${errMsg}`);
              setNodeErrors((prev) => new Map(prev).set(nodeId, errMsg));
            }
            if (newStatus === "idle") {
              setNodeErrors((prev) => {
                const next = new Map(prev);
                next.delete(nodeId);
                return next;
              });
            }
            bumpGraph();
          }
          return;
        }

        case "node:deleted": {
          nodesRef.current.delete(message.nodeId as string);
          bumpGraph();
          return;
        }

        case "edge:created": {
          const edge = message.edge as EdgeV2;
          edgesRef.current.set(edge.id, edge);
          bumpGraph();
          return;
        }

        case "edge:deleted": {
          edgesRef.current.delete(message.edgeId as string);
          bumpGraph();
          return;
        }

        case "chain:started": {
          setChainRunning(true);
          setNodeErrors(new Map());
          setMaterializePlan(null);
          materializePlanRef.current = null;
          setReviewRequest(null);
          setHostedSiteUrl(null);
          pushLog("info", "Chain started");
          return;
        }

        case "chain:complete": {
          setChainRunning(false);
          pushLog("done", "Chain complete");
          const completedPlan = materializePlanRef.current;
          if (
            completedPlan &&
            completedPlan.files.length > 0 &&
            completedPlan.errors.length === 0
          ) {
            const entry = completedPlan.files.find((f) => f.relativePath === "index.html") ??
              completedPlan.files[0];
            const previewUrl = `/preview/${completedPlan.workspacePath}/${entry?.relativePath ?? ""}`;
            setHostedSiteUrl(previewUrl);
          }
          return;
        }

        case "chain:stopped": {
          setChainRunning(false);
          setReviewRequest(null);
          pushLog("warn", "Chain stopped by user");
          return;
        }

        case "chain:error": {
          setChainRunning(false);
          setReviewRequest(null);
          pushLog("error", `Chain error: ${message.message as string}`);
          return;
        }

        case "chain:log": {
          pushLog(message.level as TerminalLevel, message.msg as string);
          return;
        }


        case "chain:apply:plan": {
          const plan = message.plan as MaterializeWritePlan;
          materializePlanRef.current = plan;
          setMaterializePlan(plan);
          return;
        }

        case "review:requested": {
          setReviewRequest({
            reviewId: message.reviewId as string,
            nodeId: message.nodeId as string,
            title: message.title as string,
            content: message.content as string,
          });
          return;
        }

        case "plan:updated": {
          setPlanElements(typeof message.elements === "string" ? message.elements : "[]");
          return;
        }

        case "chat:chunk":
        case "chat:done":
        case "chat:applied":
        case "chat:error": {
          window.dispatchEvent(new CustomEvent("dispatch:chat", { detail: message }));
          return;
        }
      }
    });

    socket.addEventListener("close", () => setStatus("disconnected"));
    socket.addEventListener("error", () => setStatus("disconnected"));

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [username]);

  return {
    status,
    users,
    nodesRef,
    edgesRef,
    selfIdRef,
    socketRef,
    graphVersion,
    chainRunning,
    terminalLogs,
    clearTerminal,
    nodeErrors,
    materializePlan,
    reviewRequest,
    chatMessages,
    chatHydrationVersion,
    sendWs: (msg: unknown) => sendJson(socketRef, msg),
    planElements,
    sendPlanUpdate: (elements: string) => sendJson(socketRef, { type: "plan:update", elements }),
    hostedSiteUrl,
    skillsMeta,
  };
}
