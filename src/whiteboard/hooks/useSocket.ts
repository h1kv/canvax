import { useEffect, useRef, useState } from "react";
import { NODE_TYPES } from "../config/nodeTypes.js";
import type { BoardNode, BoardEdge, BoardUser, NodeTypeConfig, NodeStatus, PlanNode, PlanEdge, NodeRunTraceEvent } from "../../types/index.js";

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
  nodeTypes: NodeTypeConfig[];
  nodesRef: React.MutableRefObject<Map<string, BoardNode>>;
  edgesRef: React.MutableRefObject<Map<string, BoardEdge>>;
  planNodesRef: React.MutableRefObject<Map<string, PlanNode>>;
  planEdgesRef: React.MutableRefObject<Map<string, PlanEdge>>;
  nodeRunTraceEventsRef: React.MutableRefObject<NodeRunTraceEvent[]>;
  selfIdRef: React.MutableRefObject<string | null>;
  socketRef: React.MutableRefObject<WebSocket | null>;
  graphVersion: number;
  planVersion: number;
  traceVersion: number;
  chainRunning: boolean;
  activeRunId: string | null;
  sendWs: (msg: unknown) => void;
}

export function useSocket(username: string): UseSocketResult {
  const socketRef = useRef<WebSocket | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const nodesRef = useRef<Map<string, BoardNode>>(new Map());
  const edgesRef = useRef<Map<string, BoardEdge>>(new Map());
  const planNodesRef = useRef<Map<string, PlanNode>>(new Map());
  const planEdgesRef = useRef<Map<string, PlanEdge>>(new Map());
  const nodeRunTraceEventsRef = useRef<NodeRunTraceEvent[]>([]);
  const usersRef = useRef<Map<string, BoardUser>>(new Map());

  const [status, setStatus] = useState<string>("connecting");
  const [users, setUsers] = useState<Map<string, BoardUser>>(new Map());
  const [nodeTypes, setNodeTypes] = useState<NodeTypeConfig[]>(NODE_TYPES);
  const [graphVersion, setGraphVersion] = useState<number>(0);
  const [planVersion, setPlanVersion] = useState<number>(0);
  const [traceVersion, setTraceVersion] = useState<number>(0);
  const [chainRunning, setChainRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

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

      if (message.type === "init") {
        selfIdRef.current = message.selfId as string;
        usersRef.current = new Map(
          ((message.users as BoardUser[]) || []).map((user) => [user.id, user])
        );
        nodesRef.current = new Map(
          ((message.nodes as BoardNode[]) || []).map((node) => [node.id, node])
        );
        edgesRef.current = new Map(
          ((message.edges as BoardEdge[]) || []).map((edge) => [edge.id, edge])
        );
        planNodesRef.current = new Map(
          ((message.planNodes as PlanNode[]) || []).map((node) => [node.id, node])
        );
        planEdgesRef.current = new Map(
          ((message.planEdges as PlanEdge[]) || []).map((edge) => [edge.id, edge])
        );
        nodeRunTraceEventsRef.current = (message.nodeRunTraceEvents as NodeRunTraceEvent[]) || [];
        setActiveRunId((message.activeRunId as string | null) ?? null);
        setUsers(new Map(usersRef.current));
        setNodeTypes((message.nodeTypes as NodeTypeConfig[]) || NODE_TYPES);
        setGraphVersion((v) => v + 1);
        setPlanVersion((v) => v + 1);
        setTraceVersion((v) => v + 1);
        return;
      }

      if (message.type === "user:joined") {
        const user = message.user as BoardUser;
        usersRef.current.set(user.id, user);
        setUsers(new Map(usersRef.current));
        return;
      }

      if (message.type === "user:left") {
        usersRef.current.delete(message.userId as string);
        setUsers(new Map(usersRef.current));
        setGraphVersion((v) => v + 1);
        setPlanVersion((v) => v + 1);
        return;
      }

      if (message.type === "cursor:update") {
        const user = usersRef.current.get(message.userId as string);
        if (!user) return;
        const cursorWorkspace = message.workspaceTab === "plan" ? "plan" : "canvas";
        usersRef.current.set(message.userId as string, {
          ...user,
          cursor: message.point as { x: number; y: number },
          cursorWorkspace,
        });
        setUsers(new Map(usersRef.current));
        if (cursorWorkspace === "plan") {
          setPlanVersion((v) => v + 1);
        } else {
          setGraphVersion((v) => v + 1);
        }
        return;
      }

      if (message.type === "node:created" || message.type === "node:updated") {
        const node = message.node as BoardNode;
        nodesRef.current.set(node.id, node);
        setGraphVersion((v) => v + 1);
        return;
      }

      if (message.type === "node:deleted") {
        nodesRef.current.delete(message.nodeId as string);
        for (const edgeId of (message.edgeIds as string[]) ?? []) {
          edgesRef.current.delete(edgeId);
        }
        setGraphVersion((v) => v + 1);
        return;
      }

      if (message.type === "edge:created") {
        const edge = message.edge as BoardEdge;
        edgesRef.current.set(edge.id, edge);
        setGraphVersion((v) => v + 1);
        return;
      }

      if (message.type === "edge:deleted") {
        edgesRef.current.delete(message.edgeId as string);
        setGraphVersion((v) => v + 1);
        return;
      }

      if (message.type === "plan:node:created" || message.type === "plan:node:updated") {
        const node = message.node as PlanNode;
        planNodesRef.current.set(node.id, node);
        setPlanVersion((v) => v + 1);
        return;
      }

      if (message.type === "plan:node:deleted") {
        planNodesRef.current.delete(message.nodeId as string);
        for (const edgeId of (message.edgeIds as string[]) ?? []) {
          planEdgesRef.current.delete(edgeId);
        }
        setPlanVersion((v) => v + 1);
        return;
      }

      if (message.type === "plan:edge:created") {
        const edge = message.edge as PlanEdge;
        planEdgesRef.current.set(edge.id, edge);
        setPlanVersion((v) => v + 1);
        return;
      }

      if (message.type === "plan:edge:deleted") {
        planEdgesRef.current.delete(message.edgeId as string);
        setPlanVersion((v) => v + 1);
        return;
      }

      if (message.type === "node:status") {
        const nodeId = message.nodeId as string;
        const node = nodesRef.current.get(nodeId);
        if (node) {
          nodesRef.current.set(nodeId, {
            ...node,
            status: message.status as NodeStatus,
            output: (message.output as string | null) ?? node.output,
          });
          setGraphVersion((v) => v + 1);
        }
        return;
      }

      if (message.type === "node:output") {
        const nodeId = message.nodeId as string;
        const node = nodesRef.current.get(nodeId);
        if (node) {
          nodesRef.current.set(nodeId, { ...node, output: message.output as string });
          setGraphVersion((v) => v + 1);
        }
        return;
      }

      if (message.type === "node:config:updated") {
        const node = message.node as BoardNode;
        nodesRef.current.set(node.id, node);
        setGraphVersion((v) => v + 1);
        return;
      }

      if (message.type === "chain:started") {
        setChainRunning(true);
        setActiveRunId((message.runId as string | null) ?? null);
        return;
      }

      if (message.type === "chain:complete" || message.type === "chain:stopped") {
        setChainRunning(false);
        setActiveRunId(null);
        return;
      }

      if (message.type === "chain:error") {
        setChainRunning(false);
        setActiveRunId(null);
        console.error("Chain error:", message.message);
        return;
      }

      if (message.type === "node:traces:reset") {
        nodeRunTraceEventsRef.current = [];
        setActiveRunId((message.runId as string | null) ?? null);
        setTraceVersion((v) => v + 1);
        return;
      }

      if (message.type === "node:trace") {
        const trace = message.trace as NodeRunTraceEvent;
        if (!trace?.id) return;
        nodeRunTraceEventsRef.current = [...nodeRunTraceEventsRef.current.slice(-499), trace];
        setTraceVersion((v) => v + 1);
        return;
      }

      // Chat messages — forwarded via CustomEvent so ChatPanel can listen
      // without needing its own socket reference timing dependency
      if (message.type === "chat:response" || message.type === "chat:error") {
        window.dispatchEvent(new CustomEvent("dispatch:chat", { detail: message }));
        return;
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
    sendWs: (msg: unknown) => sendJson(socketRef, msg),
  };
}
