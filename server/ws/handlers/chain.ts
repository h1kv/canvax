import type { WebSocket } from "ws";
import {
  nodes,
  edges,
  broadcast,
  activeRunId,
  appendNodeRunTraceEvent,
  resetNodeRunTraceEvents,
  setActiveRunId,
  approvalResolvers,
} from "../../state/store.js";
import { updateNodeStatus } from "../../state/operations.js";
import { runChain, type TraceEventInput } from "../../execution/engine.js";
import { debug } from "../../utils/debug.js";
import { createId } from "../../utils/id.js";
import type { NodeRunTraceEvent } from "../../../src/types/index.js";

// Track running chains and pending review resolvers
const runningChains = new Map<string, boolean>();
const reviewResolvers = new Map<string, (decision: "approved" | "rejected") => void>();

export function handleChainRun(_ws: WebSocket, userId: string): void {
  if (runningChains.get("main")) {
    debug("chain:run:already-running", { userId });
    return;
  }

  runningChains.set("main", true);
  const runId = createId("run");
  let traceSeq = 0;
  resetNodeRunTraceEvents();
  setActiveRunId(runId);

  const emitTrace = (nodeId: string | null, input: TraceEventInput): void => {
    const trace: NodeRunTraceEvent = {
      id: createId("trace"),
      runId,
      nodeId,
      seq: traceSeq++,
      at: Date.now(),
      kind: input.kind,
      level: input.level ?? "info",
      message: input.message,
      data: input.data,
    };
    appendNodeRunTraceEvent(trace);
    broadcast({ type: "node:trace", trace });
  };

  broadcast({ type: "node:traces:reset", runId });
  emitTrace(null, { kind: "chain:started", level: "info", message: "Chain started" });
  broadcast({ type: "chain:started", runId, startedAt: Date.now() });
  debug("chain:run", { userId });

  // Reset all node statuses to idle
  for (const node of nodes.values()) {
    if (node.status !== "idle") {
      const next = updateNodeStatus(node.id, "idle", undefined);
      if (next) broadcast({ type: "node:status", nodeId: node.id, status: "idle", output: null });
    }
  }

  const nodesCopy = new Map(nodes);
  const edgesCopy = new Map(edges);

  runChain(nodesCopy, edgesCopy, {
    onNodeStatus: (nodeId, status, output) => {
      const next = updateNodeStatus(nodeId, status, output);
      if (next) {
        broadcast({ type: "node:status", nodeId, status, output: output ?? null });
        emitTrace(nodeId, {
          kind: "node:status",
          level: status === "error" ? "error" : status === "paused" ? "warn" : "info",
          message: `Status: ${status}`,
          data: output === undefined ? { status } : { status, outputPreview: output.slice(0, 500), outputLength: output.length },
        });
        if (output !== undefined) {
          broadcast({ type: "node:output", nodeId, output });
        }
      }
    },
    onNodeTrace: emitTrace,
    waitForReview: (nodeId) => {
      return new Promise<"approved" | "rejected">((resolve) => {
        reviewResolvers.set(nodeId, resolve);
      });
    },
    requestToolApproval: (toolName, args) => {
      return new Promise<boolean>((resolve) => {
        const approvalId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        // We need the current nodeId — derive it from the currently running node
        const runningNode = Array.from(nodes.values()).find((n) => n.status === "running");
        const nodeId = runningNode?.id ?? "";
        approvalResolvers.set(approvalId, { resolve, nodeId, toolName, args });
        broadcast({ type: "tool:approval:request", approvalId, nodeId, toolName, args });
      });
    },
  })
    .then(() => {
      runningChains.delete("main");
      emitTrace(null, { kind: "chain:completed", level: "info", message: "Chain completed" });
      setActiveRunId(null);
      broadcast({ type: "chain:complete", runId, completedAt: Date.now() });
      debug("chain:complete", { userId });
    })
    .catch((err: Error) => {
      runningChains.delete("main");
      emitTrace(null, { kind: "node:error", level: "error", message: err.message });
      setActiveRunId(null);
      broadcast({ type: "chain:error", runId, message: err.message });
      debug("chain:error", { message: err.message });
    });
}

export function handleReviewApprove(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = message.nodeId as string;
  const resolve = reviewResolvers.get(nodeId);
  if (!resolve) {
    debug("review:approve:no-pending", { userId, nodeId });
    return;
  }
  reviewResolvers.delete(nodeId);
  resolve("approved");
  debug("review:approve", { userId, nodeId });
}

export function handleReviewReject(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const nodeId = message.nodeId as string;
  const resolve = reviewResolvers.get(nodeId);
  if (!resolve) {
    debug("review:reject:no-pending", { userId, nodeId });
    return;
  }
  reviewResolvers.delete(nodeId);
  resolve("rejected");
  debug("review:reject", { userId, nodeId });
}

export function handleToolApprovalApprove(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const approvalId = message.approvalId as string;
  const entry = approvalResolvers.get(approvalId);
  if (!entry) {
    debug("tool:approval:approve:no-pending", { userId, approvalId });
    return;
  }
  approvalResolvers.delete(approvalId);
  entry.resolve(true);
  debug("tool:approval:approve", { userId, approvalId, toolName: entry.toolName });
}

export function handleToolApprovalDeny(_ws: WebSocket, userId: string, message: Record<string, unknown>): void {
  const approvalId = message.approvalId as string;
  const entry = approvalResolvers.get(approvalId);
  if (!entry) {
    debug("tool:approval:deny:no-pending", { userId, approvalId });
    return;
  }
  approvalResolvers.delete(approvalId);
  entry.resolve(false);
  debug("tool:approval:deny", { userId, approvalId, toolName: entry.toolName });
}

export function handleChainStop(_ws: WebSocket, userId: string): void {
  const stoppedRunId = activeRunId;
  runningChains.delete("main");
  // Clear any pending review
  for (const [, resolve] of reviewResolvers) resolve("rejected");
  reviewResolvers.clear();
  // Clear any pending tool approvals (deny them all)
  for (const [, entry] of approvalResolvers) entry.resolve(false);
  approvalResolvers.clear();
  // Reset running nodes to idle
  for (const node of nodes.values()) {
    if (node.status === "running" || node.status === "paused") {
      updateNodeStatus(node.id, "idle");
      broadcast({ type: "node:status", nodeId: node.id, status: "idle", output: null });
    }
  }
  if (stoppedRunId) {
    const trace: NodeRunTraceEvent = {
      id: createId("trace"),
      runId: stoppedRunId,
      nodeId: null,
      seq: Date.now(),
      at: Date.now(),
      kind: "chain:stopped",
      level: "warn",
      message: "Chain stopped by user",
    };
    appendNodeRunTraceEvent(trace);
    broadcast({ type: "node:trace", trace });
  }
  setActiveRunId(null);
  broadcast({ type: "chain:stopped", runId: stoppedRunId, stoppedAt: Date.now() });
  debug("chain:stop", { userId });
}
