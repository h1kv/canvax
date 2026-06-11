import { randomUUID } from "node:crypto";
import { SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";
import type { EdgeV2, NodeV2 } from "../../../shared/types.js";
import { edges, nodes } from "../state/store.js";
import { updateNode } from "../state/operations.js";
import { callModel } from "./provider.js";
import { loadSkill } from "./skillLoader.js";
import { resolveMultiContent } from "./fetchUtils.js";
import { safelyMaterialize } from "./materializeSafe.js";
import { waitForReview } from "../state/reviewStore.js";
import type { RunContext } from "./engine.js";
import { containsFileMap, evaluateFailureMessage, materializeContractFailureMessage, MAX_EVALUATE_REPAIR_ATTEMPTS } from "./engine.js";

// ── Accumulated context ───────────────────────────────────────────────────────
//
// Each node's full output is stored here. Downstream nodes receive a structured
// brief built from this map — no truncation, no lossy summarization.

interface AccumulatedContext {
  goal: string;
  byId: Map<string, string>;          // full output per nodeId
  orderedNodeIds: string[];           // insertion order
}

function createAccumulatedContext(goal: string): AccumulatedContext {
  return { goal, byId: new Map(), orderedNodeIds: [] };
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

  let flowInput = initialFlowInput;
  let lastFileMapArtifact: string | null = null;
  const evaluateRepairAttempts = new Map<string, number>();

  while (currentNodeId && !ctx.abortSignal.aborted) {
    const node = nodes.get(currentNodeId);
    if (!node) break;

    ctx.onNodeStatus(node.id, "running", null);
    updateNode(node.id, { status: "running", output: null });

    try {
      let output: string;
      let nextNodeId: string | null = edgesFrom(node.id, "flow")[0]?.targetId ?? null;

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
          while (failure && (evaluateRepairAttempts.get(node.id) ?? 0) < MAX_EVALUATE_REPAIR_ATTEMPTS) {
            const previousCreateNode = firstPreviousFlowNode(node.id);
            if (!previousCreateNode || previousCreateNode.type !== "create") break;
            const attempt = evaluateRepairAttempts.get(node.id) ?? 0;
            evaluateRepairAttempts.set(node.id, attempt + 1);
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
      } else {
        output = flowInput;
      }

      updateNode(node.id, { status: "done", output });
      ctx.onNodeStatus(node.id, "done", output);
      storeOutput(acc, node, output);

      if (containsFileMap(output)) lastFileMapArtifact = output;

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
      interface ChainError extends Error { nodeId?: string; }
      const chainErr = new Error(message) as ChainError;
      chainErr.nodeId = node.id;
      throw chainErr;
    }
  }
}
