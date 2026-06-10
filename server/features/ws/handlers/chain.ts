import type { WebSocket } from "ws";
import type { MaterializeWritePlan, NodeStatus, ReviewRequest, RunLedger } from "../../../../shared/types.js";
import { broadcast, nodes } from "../../state/store.js";
import { rejectAllPending } from "../../state/reviewStore.js";
import { runChain, runChainFrom } from "../../execution/engine.js";
import { persistRunLedger } from "../../state/runLedgerStore.js";
import { debug } from "../../../utils/debug.js";

let abortController: AbortController | null = null;

function makeRunContext(workspacePath: string, signal: AbortSignal) {
  return {
    workspacePath,
    abortSignal: signal,
    onNodeStatus(nodeId: string, status: NodeStatus, output: string | null) {
      broadcast({ type: "node:status", nodeId, status, output });
    },
    onLog(level: "info" | "warn" | "error" | "done", msg: string) {
      broadcast({ type: "chain:log", level, msg });
    },
    onMaterializePlan(plan: MaterializeWritePlan) {
      broadcast({ type: "chain:materialize:plan", plan });
    },
    onReviewRequested(req: ReviewRequest) {
      broadcast({ type: "review:requested", ...req });
    },
    onLedgerUpdated(ledger: RunLedger) {
      broadcast({ type: "ledger:updated", ledger });
    },
    onNeedsInput(message: string, ledger: RunLedger, nodeId?: string | null) {
      broadcast({ type: "chain:needs_input", message, prompt: message, ledger, nodeId: nodeId ?? null });
      broadcast({ type: "chain:log", level: "warn", msg: `Chain needs verified input: ${message.split("\n")[0]}` });
    },
  };
}

function getWorkspacePath(): string {
  const initialiser = Array.from(nodes.values()).find((n) => n.type === "initialiser");
  return initialiser?.config?.workspacePath ?? "./workspace";
}

export function handleChainRun(_ws: WebSocket, _userId: string, _message: Record<string, unknown>): void {
  if (abortController) {
    debug("chain:run:already-running");
    return;
  }

  abortController = new AbortController();
  broadcast({ type: "chain:started" });

  void (async () => {
    try {
      const ledger = await runChain(makeRunContext(getWorkspacePath(), abortController!.signal));
      persistRunLedger(ledger, "complete");
      broadcast({ type: "chain:complete" });
      debug("chain:complete");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const nodeId = (err as { nodeId?: string }).nodeId;
      const ledger = (err as { ledger?: RunLedger }).ledger;
      const needsInput = Boolean((err as { needsInput?: boolean }).needsInput);
      if (ledger) persistRunLedger(ledger, needsInput ? "needs_input" : "error");
      rejectAllPending(message);
      broadcast({ type: "chain:error", message, nodeId });
      debug("chain:error", { message });
    } finally {
      abortController = null;
    }
  })();
}

export function handleChainRetry(_ws: WebSocket, _userId: string, message: Record<string, unknown>): void {
  if (abortController) {
    debug("chain:retry:already-running");
    return;
  }

  const fromNodeId = message.fromNodeId as string | undefined;
  if (!fromNodeId) {
    debug("chain:retry:missing-fromNodeId");
    return;
  }

  abortController = new AbortController();
  broadcast({ type: "chain:started" });

  void (async () => {
    try {
      const ledger = await runChainFrom(fromNodeId, makeRunContext(getWorkspacePath(), abortController!.signal));
      persistRunLedger(ledger, "complete");
      broadcast({ type: "chain:complete" });
      debug("chain:retry:complete", { fromNodeId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const nodeId = (err as { nodeId?: string }).nodeId;
      const ledger = (err as { ledger?: RunLedger }).ledger;
      const needsInput = Boolean((err as { needsInput?: boolean }).needsInput);
      if (ledger) persistRunLedger(ledger, needsInput ? "needs_input" : "error");
      rejectAllPending(message);
      broadcast({ type: "chain:error", message, nodeId });
      debug("chain:retry:error", { message });
    } finally {
      abortController = null;
    }
  })();
}

export function handleChainStop(_ws: WebSocket, _userId: string, _message: Record<string, unknown>): void {
  if (abortController) {
    rejectAllPending("Chain stopped by user");
    abortController.abort();
    abortController = null;
    broadcast({ type: "chain:stopped" });
    debug("chain:stop");
  }
}
