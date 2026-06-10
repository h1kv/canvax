import { randomUUID } from "node:crypto";
import { SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";
import type { EdgeV2, MaterializeWritePlan, NodeV2, ReviewRequest, RunLedger } from "../../../shared/types.js";
import { edges, nodes } from "../state/store.js";
import { updateNode } from "../state/operations.js";
import { callOpenAI, callOpenAIWithTools } from "./provider.js";
import { loadSkill } from "./skillLoader.js";
import { resolveMultiContent } from "./fetchUtils.js";
import { safelyMaterialize } from "./materializeSafe.js";
import { waitForReview } from "../state/reviewStore.js";
import {
  addEvaluationIssue,
  addNodeOutputSummary,
  addUserFacts,
  cloneLedger,
  createRunLedger,
  ledgerSummary,
} from "./evidence.js";

export const MAX_EVALUATE_REPAIR_ATTEMPTS = 0;

export interface RunContext {
  workspacePath: string;
  onNodeStatus: (nodeId: string, status: NodeV2["status"], output: string | null) => void;
  onLog: (level: "info" | "warn" | "error" | "done", msg: string) => void;
  onMaterializePlan: (plan: MaterializeWritePlan) => void;
  onReviewRequested: (req: ReviewRequest) => void;
  onLedgerUpdated: (ledger: RunLedger) => void;
  onNeedsInput: (message: string, ledger: RunLedger, nodeId?: string | null) => void;
  abortSignal: AbortSignal;
}

interface ChainError extends Error {
  nodeId?: string;
  ledger?: RunLedger;
  needsInput?: boolean;
}

export function evaluateFailureMessage(output: string): string | null {
  if (!/^\s*(?:\*\*)?VERDICT:\s*FAIL(?:\*\*)?/im.test(output)) return null;
  return `Evaluate failed:\n${output.trim()}`;
}

export function containsFileMap(output: string): boolean {
  return /^---\s*FILE:\s*.+?\s*---\s*$/m.test(output);
}

export function canRepairEvaluationFailure(attempt: number): boolean {
  return attempt < MAX_EVALUATE_REPAIR_ATTEMPTS;
}

function findInitialiser(): NodeV2 | null {
  for (const node of nodes.values()) {
    if (node.type === "initialiser") return node;
  }
  return null;
}

function edgesFrom(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.sourceId === nodeId && e.kind === kind);
}

function edgesTo(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.targetId === nodeId && e.kind === kind);
}

function buildGraphGoal(initialiser: NodeV2 | null): string {
  const parts: string[] = [];
  if (initialiser?.config?.content?.trim()) parts.push(initialiser.config.content.trim());
  for (const node of nodes.values()) {
    if (SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number]) && node.config?.taskPrompt?.trim()) {
      parts.push(node.config.taskPrompt.trim());
    }
  }
  return parts.join("\n\n").trim();
}

function hasFlowPathToMaterialize(nodeId: string, visited = new Set<string>()): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);

  for (const edge of edgesFrom(nodeId, "flow")) {
    const target = nodes.get(edge.targetId);
    if (!target) continue;
    if (target.type === "materialize") return true;
    if (hasFlowPathToMaterialize(target.id, visited)) return true;
  }

  return false;
}

function firstPreviousFlowNode(nodeId: string): NodeV2 | null {
  const incoming = edgesTo(nodeId, "flow")[0];
  return incoming ? nodes.get(incoming.sourceId) ?? null : null;
}

export function materializeContractFailureMessage(node: NodeV2, output: string): string | null {
  // Evaluate no longer needs to pass through the file map — the engine injects the stored
  // Create artifact directly into Materialize's flowInput after Evaluate passes.
  if (node.type !== "create") return null;
  if (!hasFlowPathToMaterialize(node.id)) return null;
  if (containsFileMap(output)) return null;
  return `Create "${node.title}" feeds Materialize but did not emit any file blocks. Materialize can only write outputs that use --- FILE: path --- delimiters.`;
}

// BFS over flow + reject edges to find all nodes reachable from a starting node.
// Used to reset statuses before a chain run.
function buildAllReachable(startId: string): NodeV2[] {
  const result: NodeV2[] = [];
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    result.push(node);
    for (const edge of edges.values()) {
      if (edge.sourceId === id && (edge.kind === "flow" || edge.kind === "reject")) {
        queue.push(edge.targetId);
      }
    }
  }
  return result;
}

async function gatherMidputContent(nodeId: string, ledger: RunLedger): Promise<string> {
  const midputEdges = edgesTo(nodeId, "midput");
  const parts: string[] = [];
  for (const edge of midputEdges) {
    const source = nodes.get(edge.sourceId);
    if (!source) continue;
    const raw = source.config?.content?.trim() ?? source.output?.trim() ?? "";
    if (!raw) continue;
    const resolved = await resolveMultiContent(raw);
    parts.push(resolved);
    addUserFacts(ledger, resolved, `context:${source.id}`, source.id, source.type === "context" ? "context" : "node");
  }
  return parts.join("\n\n---\n\n");
}

export function buildUserMessage(
  flowInput: string,
  midputContent: string,
  taskPrompt: string,
  ledger?: RunLedger
): string {
  const sections: string[] = [];
  if (ledger) sections.push(ledgerSummary(ledger));
  if (midputContent) sections.push(`[Context]\n${midputContent}`);
  if (flowInput) sections.push(`[Chain Input]\n${flowInput}`);
  if (taskPrompt) sections.push(`[Task At Hand]\n${taskPrompt}`);
  return sections.join("\n\n");
}


async function runCreateRepair(
  createNode: NodeV2,
  failedEvaluateNode: NodeV2,
  previousCreateOutput: string,
  evaluationFailure: string,
  ledger: RunLedger,
  ctx: RunContext
): Promise<string> {
  const skill = loadSkill("create");
  const taskPrompt = [
    createNode.config?.taskPrompt ?? "",
    "",
    `[Repair required by ${failedEvaluateNode.title}]`,
    evaluationFailure,
    "",
    "Repair the artifact. Preserve verified facts only. Return a complete file map and nothing else.",
  ].join("\n").trim();
  const userMessage = buildUserMessage(previousCreateOutput, "", taskPrompt, ledger);
  ctx.onLog("warn", `Repairing via ${createNode.title}`);
  ctx.onNodeStatus(createNode.id, "running", null);
  updateNode(createNode.id, { status: "running", output: null });
  const repaired = await callOpenAI({ systemPrompt: skill, userMessage });
  const contractFailure = materializeContractFailureMessage(createNode, repaired);
  if (contractFailure) throw new Error(contractFailure);
  updateNode(createNode.id, { status: "done", output: repaired });
  ctx.onNodeStatus(createNode.id, "done", repaired);
  addNodeOutputSummary(ledger, createNode, repaired);
  ctx.onLedgerUpdated(cloneLedger(ledger));
  return repaired;
}

// Dynamic chain walk — supports Review branching onto reject edges.
async function executeFrom(startNodeId: string, initialFlowInput: string, ctx: RunContext, ledger: RunLedger): Promise<void> {
  let currentNodeId: string | null = startNodeId;
  let flowInput = initialFlowInput;
  const evaluateRepairAttempts = new Map<string, number>();
  // Stores the last Create output that contained a valid file map.
  // Injected into Materialize's flowInput after Evaluate passes, so Evaluate
  // only needs to emit a verdict — not re-emit the full file map.
  let lastFileMapArtifact: string | null = null;

  while (currentNodeId && !ctx.abortSignal.aborted) {
    const node = nodes.get(currentNodeId);
    if (!node) break;

    ctx.onNodeStatus(node.id, "running", null);
    updateNode(node.id, { status: "running", output: null });

    try {
      let output: string;
      let nextNodeId: string | null = edgesFrom(node.id, "flow")[0]?.targetId ?? null;

      if (node.type === "materialize") {
        output = safelyMaterialize(
          flowInput,
          ctx.workspacePath,
          (level, msg) => ctx.onLog(level, msg),
          (plan) => ctx.onMaterializePlan(plan)
        );
      } else if (node.type === "review") {
        const reviewId = randomUUID();
        ctx.onReviewRequested({ reviewId, nodeId: node.id, title: node.title, content: flowInput });
        const result = await waitForReview(reviewId, ctx.abortSignal);

        if (result.action === "reject") {
          output = flowInput;
          nextNodeId = edgesFrom(node.id, "reject")[0]?.targetId ?? null;
          if (!nextNodeId) throw new Error(`Review "${node.title}" rejected — connect the reject output to handle this case`);
        } else if (result.action === "request-changes" && result.notes) {
          output = `[Review Notes]\n${result.notes}\n\n[Original]\n${flowInput}`;
        } else {
          // approve
          output = flowInput;
        }
      } else if (node.type === "parallel") {
        const branches = node.config?.branches ?? [];
        if (branches.length === 0) throw new Error(`Parallel node "${node.title}" has no branches — add at least one branch in the node config`);
        const skill = loadSkill("parallel");
        const midputContent = await gatherMidputContent(node.id, ledger);
        ctx.onLog("info", `Running ${branches.length} parallel branches…`);
        const results = await Promise.all(
          branches.map(async (branch, i) => {
            const userMessage = buildUserMessage(flowInput, midputContent, branch.taskPrompt, ledger);
            ctx.onLog("info", `  → Branch ${i + 1}: ${branch.label}`);
            const result = await callOpenAI({ systemPrompt: skill, userMessage });
            return { label: branch.label, output: result };
          })
        );
        output = results.map((r) => `## ${r.label}\n\n${r.output}`).join("\n\n---\n\n");
      } else if (SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number])) {
        const skill = loadSkill(node.type);
        const midputContent = await gatherMidputContent(node.id, ledger);
        const taskPrompt = node.config?.taskPrompt ?? "";
        const userMessage = buildUserMessage(flowInput, midputContent, taskPrompt, ledger);
        if (!userMessage.trim()) throw new Error(`Node "${node.title}" has no task prompt or input`);
        output = await (node.type === "investigate"
          ? callOpenAIWithTools({ systemPrompt: skill, userMessage })
          : callOpenAI({ systemPrompt: skill, userMessage }));
        if (node.type === "evaluate") {
          let failure = evaluateFailureMessage(output);
          while (failure && canRepairEvaluationFailure(evaluateRepairAttempts.get(node.id) ?? 0)) {
            addEvaluationIssue(ledger, failure);
            const previousCreateNode = firstPreviousFlowNode(node.id);
            if (!previousCreateNode || previousCreateNode.type !== "create") break;
            const attempt = evaluateRepairAttempts.get(node.id) ?? 0;
            evaluateRepairAttempts.set(node.id, attempt + 1);
            flowInput = await runCreateRepair(previousCreateNode, node, flowInput, failure, ledger, ctx);
            if (containsFileMap(flowInput)) lastFileMapArtifact = flowInput;
            const repairUserMessage = buildUserMessage(flowInput, midputContent, taskPrompt, ledger);
            output = await callOpenAI({ systemPrompt: skill, userMessage: repairUserMessage });
            failure = evaluateFailureMessage(output);
          }
          if (failure) {
            addEvaluationIssue(ledger, failure);
            throw new Error(failure);
          }
        }
        const materializeContractFailure = materializeContractFailureMessage(node, output);
        if (materializeContractFailure) throw new Error(materializeContractFailure);
      } else {
        output = flowInput;
      }

      updateNode(node.id, { status: "done", output });
      ctx.onNodeStatus(node.id, "done", output);
      addNodeOutputSummary(ledger, node, output);
      ctx.onLedgerUpdated(cloneLedger(ledger));

      // Track the last Create output that contains a valid file map.
      if (containsFileMap(output)) lastFileMapArtifact = output;

      // After Evaluate passes, route the stored Create artifact to Materialize instead of
      // Evaluate's verdict prose. Evaluate's output is stored on the node for display only.
      if (node.type === "evaluate" && hasFlowPathToMaterialize(node.id) && lastFileMapArtifact) {
        flowInput = lastFileMapArtifact;
        ctx.onLog("info", "Evaluate passed — routing Create artifact to Materialize");
      } else {
        flowInput = output;
      }
      currentNodeId = nextNodeId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateNode(node.id, { status: "error", output: message });
      ctx.onNodeStatus(node.id, "error", message);
      const chainErr = new Error(message) as ChainError;
      chainErr.nodeId = node.id;
      const sourceErr = typeof err === "object" && err !== null ? err as ChainError : null;
      chainErr.ledger = sourceErr?.ledger ?? cloneLedger(ledger);
      chainErr.needsInput = Boolean(sourceErr?.needsInput);
      throw chainErr;
    }
  }
}

export async function runChain(ctx: RunContext): Promise<RunLedger> {
  const initialiser = findInitialiser();
  if (!initialiser) throw new Error("No Initialiser node on canvas");

  const firstEdge = edgesFrom(initialiser.id, "flow")[0];
  if (!firstEdge) throw new Error("Initialiser has no connected flow output");

  const reachable = buildAllReachable(firstEdge.targetId);
  if (reachable.length === 0) throw new Error("Chain is empty");

  for (const node of reachable) {
    updateNode(node.id, { status: "idle", output: null });
    ctx.onNodeStatus(node.id, "idle", null);
  }

  const seedInput = initialiser.config?.content?.trim() ?? "";
  const ledger = createRunLedger(buildGraphGoal(initialiser));
  if (seedInput) addUserFacts(ledger, seedInput, `initialiser:${initialiser.id}`, initialiser.id, "user");
  ctx.onLedgerUpdated(cloneLedger(ledger));
  await executeFrom(firstEdge.targetId, seedInput, ctx, ledger);
  return cloneLedger(ledger);
}

export async function runChainFrom(fromNodeId: string, ctx: RunContext): Promise<RunLedger> {
  const reachable = buildAllReachable(fromNodeId);
  if (reachable.length === 0) throw new Error(`Node ${fromNodeId} not found`);

  for (const node of reachable) {
    updateNode(node.id, { status: "idle", output: null });
    ctx.onNodeStatus(node.id, "idle", null);
  }

  // Seed from the output of whichever node feeds into fromNodeId via flow
  const upstreamFlowEdge = Array.from(edges.values()).find(
    (e) => e.targetId === fromNodeId && e.kind === "flow"
  );
  const upstreamNode = upstreamFlowEdge ? nodes.get(upstreamFlowEdge.sourceId) : null;

  let seedInput: string;
  if (upstreamNode?.type === "initialiser") {
    seedInput = upstreamNode.config?.content?.trim() ?? "";
  } else {
    seedInput = upstreamNode?.output ?? "";
  }

  const initialiser = findInitialiser();
  const ledger = createRunLedger(buildGraphGoal(initialiser));
  if (initialiser?.config?.content?.trim()) {
    addUserFacts(ledger, initialiser.config.content.trim(), `initialiser:${initialiser.id}`, initialiser.id, "user");
  }
  if (upstreamNode && upstreamNode.type !== "initialiser" && seedInput) {
    addNodeOutputSummary(ledger, upstreamNode, seedInput);
  }
  ctx.onLedgerUpdated(cloneLedger(ledger));
  await executeFrom(fromNodeId, seedInput, ctx, ledger);
  return cloneLedger(ledger);
}
