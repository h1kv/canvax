import { randomUUID } from "node:crypto";
import { SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";
import type { EdgeV2, NodeV2 } from "../../../shared/types.js";
import { edges, nodes } from "../state/store.js";
import { updateNode } from "../state/operations.js";
import { callModel } from "./provider.js";
import { loadSkill } from "./skillLoader.js";
import { resolveMultiContent } from "./fetchUtils.js";
import { safelyMaterialize } from "./materializeSafe.js";
import { deployToVercel } from "./deployToVercel.js";
import { waitForReview } from "../state/reviewStore.js";
import type { RunContext } from "./engine.js";
import { containsFileMap, evaluateFailureMessage, materializeContractFailureMessage, MAX_EVALUATE_REPAIR_ATTEMPTS } from "./engine.js";

// ── Accumulated context ───────────────────────────────────────────────────────

interface AccumulatedContext {
  goal: string;
  byId: Map<string, string>;
  orderedNodeIds: string[];
}

function createAccumulatedContext(goal: string): AccumulatedContext {
  return { goal, byId: new Map(), orderedNodeIds: [] };
}

function cloneAccumulatedContext(acc: AccumulatedContext): AccumulatedContext {
  return { goal: acc.goal, byId: new Map(acc.byId), orderedNodeIds: [...acc.orderedNodeIds] };
}

function storeOutput(acc: AccumulatedContext, node: NodeV2, output: string): void {
  acc.byId.set(node.id, output);
  acc.orderedNodeIds.push(node.id);
}

function buildContextBrief(
  node: NodeV2,
  acc: AccumulatedContext,
  midputContent: string,
  taskPrompt: string
): string {
  const sections: string[] = [];

  sections.push(`## Run Goal\n${acc.goal}`);

  if (acc.orderedNodeIds.length > 0) {
    const priorOutputs = acc.orderedNodeIds
      .map((id) => {
        const n = nodes.get(id);
        const output = acc.byId.get(id);
        if (!n || !output) return null;
        return `### ${n.title} (${n.type})\n${output}`;
      })
      .filter(Boolean)
      .join("\n\n");

    if (priorOutputs) sections.push(`## Prior Work\n${priorOutputs}`);
  }

  if (midputContent) sections.push(`## Context\n${midputContent}`);
  if (taskPrompt) sections.push(`## Your Task\n${taskPrompt}`);

  return sections.join("\n\n---\n\n");
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

function edgesFrom(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.sourceId === nodeId && e.kind === kind);
}

function edgesTo(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.targetId === nodeId && e.kind === kind);
}

function firstPreviousFlowNode(nodeId: string): NodeV2 | null {
  const incoming = edgesTo(nodeId, "flow")[0];
  return incoming ? nodes.get(incoming.sourceId) ?? null : null;
}

function hasFlowPathToMaterialize(nodeId: string, visited = new Set<string>()): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);
  for (const edge of edgesFrom(nodeId, "flow")) {
    const target = nodes.get(edge.targetId);
    if (!target) continue;
    if (target.type === "apply") return true;
    if (hasFlowPathToMaterialize(target.id, visited)) return true;
  }
  return false;
}

async function gatherMidputContent(nodeId: string): Promise<string> {
  const midputEdges = edgesTo(nodeId, "midput");
  const parts: string[] = [];
  for (const edge of midputEdges) {
    const source = nodes.get(edge.sourceId);
    if (!source) continue;
    const raw = source.config?.content?.trim() ?? source.output?.trim() ?? "";
    if (!raw) continue;
    parts.push(await resolveMultiContent(raw));
  }
  return parts.join("\n\n---\n\n");
}

// ── Repair helper ─────────────────────────────────────────────────────────────

async function runCreateRepair(
  createNode: NodeV2,
  failedEvaluateNode: NodeV2,
  acc: AccumulatedContext,
  evaluationFailure: string,
  ctx: RunContext
): Promise<string> {
  const skill = loadSkill("create");
  const taskPrompt = [
    createNode.config?.taskPrompt ?? "",
    "",
    `[Repair requested by ${failedEvaluateNode.title}]`,
    evaluationFailure,
    "",
    "Repair the artifact. Return a complete file map using --- FILE: path --- delimiters.",
  ].join("\n").trim();

  const midputContent = await gatherMidputContent(createNode.id);
  const userMessage = buildContextBrief(createNode, acc, midputContent, taskPrompt);

  ctx.onLog("warn", `Repairing via ${createNode.title}`);
  ctx.onNodeStatus(createNode.id, "running", null);
  updateNode(createNode.id, { status: "running", output: null });

  const repaired = await callModel({ systemPrompt: skill.systemPrompt, userMessage, meta: skill.meta });
  const contractFailure = materializeContractFailureMessage(createNode, repaired);
  if (contractFailure) throw new Error(contractFailure);

  updateNode(createNode.id, { status: "done", output: repaired });
  ctx.onNodeStatus(createNode.id, "done", repaired);
  return repaired;
}

// ── Execute a single node (shared by main loop and branch runner) ─────────────

interface NodeExecState {
  flowInput: string;
  lastFileMapArtifact: string | null;
  evaluateRepairAttempts: Map<string, number>;
  acc: AccumulatedContext;
}

interface NodeExecResult {
  output: string;
  nextNodeId: string | null;
  lastFileMapArtifact: string | null;
}

async function executeNode(
  node: NodeV2,
  state: NodeExecState,
  ctx: RunContext
): Promise<NodeExecResult> {
  const { flowInput, acc } = state;
  let lastFileMapArtifact = state.lastFileMapArtifact;
  let nextNodeId: string | null = edgesFrom(node.id, "flow")[0]?.targetId ?? null;
  let output: string;

  if (node.type === "apply") {
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
      output = flowInput;
    }
  } else if (SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number])) {
    const skill = loadSkill(node.type);
    const midputContent = await gatherMidputContent(node.id);
    const taskPrompt = node.config?.taskPrompt ?? "";

    const isBlindInvestigate = node.type === "investigate" && acc.orderedNodeIds.length === 0;
    const userMessage = isBlindInvestigate
      ? [flowInput, midputContent, taskPrompt].filter(Boolean).join("\n\n").trim()
      : buildContextBrief(node, acc, midputContent, taskPrompt);

    if (!userMessage.trim()) throw new Error(`Node "${node.title}" has no task prompt or input`);

    ctx.onLog("info", `[${node.title}] model: ${skill.meta.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1"}`);
    const onProgress = skill.meta.tools?.includes("file_tools")
      ? (msg: string) => ctx.onLog("info", `[${node.title}] ${msg}`)
      : undefined;
    output = await callModel({ systemPrompt: skill.systemPrompt, userMessage, meta: skill.meta, onProgress });

    if (node.type === "evaluate") {
      let failure = evaluateFailureMessage(output);
      while (failure && (state.evaluateRepairAttempts.get(node.id) ?? 0) < MAX_EVALUATE_REPAIR_ATTEMPTS) {
        const previousCreateNode = firstPreviousFlowNode(node.id);
        if (!previousCreateNode || previousCreateNode.type !== "create") break;
        const attempt = state.evaluateRepairAttempts.get(node.id) ?? 0;
        state.evaluateRepairAttempts.set(node.id, attempt + 1);
        const repairedOutput = await runCreateRepair(previousCreateNode, node, acc, failure, ctx);
        storeOutput(acc, previousCreateNode, repairedOutput);
        if (containsFileMap(repairedOutput)) lastFileMapArtifact = repairedOutput;
        const repairUserMessage = buildContextBrief(node, acc, midputContent, taskPrompt);
        const evalSkill = loadSkill("evaluate");
        output = await callModel({ systemPrompt: evalSkill.systemPrompt, userMessage: repairUserMessage, meta: evalSkill.meta });
        failure = evaluateFailureMessage(output);
      }
      if (failure) throw new Error(failure);
    }

    const contractFailure = materializeContractFailureMessage(node, output);
    if (contractFailure) throw new Error(contractFailure);
  } else if (node.type === "deploy") {
    const deployPath = node.config?.workspacePath?.trim() || ctx.workspacePath;
    ctx.onLog("info", `[${node.title}] Committing and pushing ${deployPath} → rapid-deployments…`);
    output = await deployToVercel(deployPath, ctx.abortSignal);
    ctx.onLog("info", `[${node.title}] ${output.split("\n")[0]}`);
  } else {
    // passthrough (parallel, merge, unknown control nodes)
    output = flowInput;
  }

  if (containsFileMap(output)) lastFileMapArtifact = output;

  return { output, nextNodeId, lastFileMapArtifact };
}

// ── Parallel branch runner ────────────────────────────────────────────────────

interface BranchResult {
  mergeNodeId: string;
  output: string;
  branchTitle: string;
}

async function runBranchUntilMerge(
  startNodeId: string,
  flowInput: string,
  acc: AccumulatedContext,
  ctx: RunContext
): Promise<BranchResult> {
  let currentNodeId: string | null = startNodeId;
  const state: NodeExecState = {
    flowInput,
    lastFileMapArtifact: null,
    evaluateRepairAttempts: new Map(),
    acc,
  };
  const branchTitle = nodes.get(startNodeId)?.title ?? startNodeId;

  while (currentNodeId && !ctx.abortSignal.aborted) {
    const node = nodes.get(currentNodeId);
    if (!node) break;

    if (node.type === "merge") {
      return { mergeNodeId: node.id, output: state.flowInput, branchTitle };
    }

    ctx.onNodeStatus(node.id, "running", null);
    updateNode(node.id, { status: "running", output: null });

    try {
      const result = await executeNode(node, state, ctx);

      updateNode(node.id, { status: "done", output: result.output });
      ctx.onNodeStatus(node.id, "done", result.output);
      storeOutput(acc, node, result.output);

      state.lastFileMapArtifact = result.lastFileMapArtifact;

      if (node.type === "evaluate" && hasFlowPathToMaterialize(node.id) && result.lastFileMapArtifact) {
        state.flowInput = result.lastFileMapArtifact;
        ctx.onLog("info", "Evaluate passed — routing Create artifact to Materialize");
      } else {
        state.flowInput = result.output;
      }

      currentNodeId = result.nextNodeId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateNode(node.id, { status: "error", output: message });
      ctx.onNodeStatus(node.id, "error", message);
      interface ChainError extends Error { nodeId?: string; }
      const chainErr = new Error(message) as ChainError;
      (chainErr as ChainError).nodeId = node.id;
      throw chainErr;
    }
  }

  // Branch ended without reaching a merge node
  return { mergeNodeId: "", output: state.flowInput, branchTitle };
}

// ── Main orchestrator loop ────────────────────────────────────────────────────

export async function orchestratorLoop(
  startNodeId: string,
  initialFlowInput: string,
  goal: string,
  ctx: RunContext
): Promise<void> {
  let currentNodeId: string | null = startNodeId;
  const acc = createAccumulatedContext(goal);

  // Pre-seed accumulated context from already-completed nodes (for mid-chain retries)
  for (const node of nodes.values()) {
    if (node.output && node.status === "done" && node.type !== "initialiser") {
      storeOutput(acc, node, node.output);
    }
  }

  const state: NodeExecState = {
    flowInput: initialFlowInput,
    lastFileMapArtifact: null,
    evaluateRepairAttempts: new Map(),
    acc,
  };

  while (currentNodeId && !ctx.abortSignal.aborted) {
    const node = nodes.get(currentNodeId);
    if (!node) break;

    ctx.onNodeStatus(node.id, "running", null);
    updateNode(node.id, { status: "running", output: null });

    try {
      let output: string;
      let nextNodeId: string | null;

      if (node.type === "parallel") {
        const branchEdges = edgesFrom(node.id, "flow");
        if (branchEdges.length < 2) throw new Error(`Parallel "${node.title}" needs ≥ 2 outgoing flow edges`);

        ctx.onLog("info", `[${node.title}] starting ${branchEdges.length} parallel branches`);

        const branchResults = await Promise.all(
          branchEdges.map((e) => runBranchUntilMerge(e.targetId, state.flowInput, cloneAccumulatedContext(acc), ctx))
        );

        const mergeIds = [...new Set(branchResults.map((r) => r.mergeNodeId).filter(Boolean))];
        if (mergeIds.length !== 1) {
          throw new Error(`Parallel "${node.title}" branches must all connect to the same Merge node`);
        }

        const mergeNodeId = mergeIds[0];
        const mergedOutput = branchResults
          .map((r) => `## Branch: ${r.branchTitle}\n${r.output}`)
          .join("\n\n---\n\n");

        ctx.onLog("info", `[${node.title}] all branches done — merging at "${nodes.get(mergeNodeId)?.title ?? mergeNodeId}"`);

        // Process the merge node
        const mergeNode = nodes.get(mergeNodeId);
        if (mergeNode) {
          updateNode(mergeNode.id, { status: "done", output: mergedOutput });
          ctx.onNodeStatus(mergeNode.id, "done", mergedOutput);
          storeOutput(acc, mergeNode, mergedOutput);
          nextNodeId = edgesFrom(mergeNode.id, "flow")[0]?.targetId ?? null;
        } else {
          nextNodeId = null;
        }

        output = mergedOutput;
      } else {
        const result = await executeNode(node, state, ctx);
        output = result.output;
        nextNodeId = result.nextNodeId;
        state.lastFileMapArtifact = result.lastFileMapArtifact;
      }

      updateNode(node.id, { status: "done", output });
      ctx.onNodeStatus(node.id, "done", output);
      storeOutput(acc, node, output);

      if (node.type === "evaluate" && hasFlowPathToMaterialize(node.id) && state.lastFileMapArtifact) {
        state.flowInput = state.lastFileMapArtifact;
        ctx.onLog("info", "Evaluate passed — routing Create artifact to Materialize");
      } else {
        state.flowInput = output;
      }

      currentNodeId = nextNodeId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateNode(node.id, { status: "error", output: message });
      ctx.onNodeStatus(node.id, "error", message);
      interface ChainError extends Error { nodeId?: string; }
      const chainErr = new Error(message) as ChainError;
      (chainErr as ChainError).nodeId = node.id;
      throw chainErr;
    }
  }
}
