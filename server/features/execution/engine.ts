import path from "node:path";
import {
  callOpenAI,
  callOpenAIToolRound,
  callOpenAIResponses,
  type OpenAIMessage,
  type OpenAIResponsesResult,
  type OpenAIWebSearchTool,
} from "./providers/openai.js";
import {
  buildAgentToolInstructions,
  executeAgentTool,
  getAgentToolSchemas,
  normalizeAllowedAgentTools,
  resolveWorkspacePath,
  webSearch,
  type AgentToolName,
  type ApprovalCallback,
} from "./tools/agentTools.js";
import {
  addLedgerFact,
  addLedgerSource,
  artifactQualityIssues,
  buildLedgerSummary,
  completeRunLedger,
  createRunLedger,
  recordArtifact,
  recordEvaluation,
  recordNodeOutput,
  recordRepair,
  stripMarkdownFenceForPath,
  stripSingleMarkdownFence,
} from "./ledger.js";
import type { EdgeKind, RunLedger, NodeRunTraceKind } from "../../../shared/types.js";
import { getSkillPrompt } from "../skills/loader.js";

export type NodeStatus = "idle" | "running" | "done" | "error" | "paused";

export interface ServerNode {
  id: string;
  typeId: string;
  label: string;
  x: number; y: number;
  width: number; height: number;
  config: Record<string, unknown>;
  status: NodeStatus;
  output: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ServerEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourcePort: string;
  edgeKind?: EdgeKind;
  createdBy: string;
  createdAt: number;
}

export type ReviewDecision = "approved" | "rejected";

export interface ChainCallbacks {
  runId?: string;
  onNodeStatus: (nodeId: string, status: NodeStatus, output?: string) => void;
  onNodeTrace?: (nodeId: string, event: TraceEventInput) => void;
  waitForReview: (nodeId: string) => Promise<ReviewDecision>;
  requestToolApproval?: ApprovalCallback;
  readWorkspaceMemory?: (key: string) => string | undefined;
  writeWorkspaceMemory?: (key: string, value: string) => void;
}

export interface TraceEventInput {
  kind: NodeRunTraceKind;
  level?: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

interface ToolResultRecord {
  toolName: string;
  args?: Record<string, unknown>;
  result: string;
  sources?: Array<{ url?: string; title?: string }>;
}

type ToolResultObserver = (record: ToolResultRecord) => void;

async function callOpenAIWithNativeTools(
  model: string,
  systemPrompt: string,
  userMessage: string,
  allowedTools: AgentToolName[],
  maxToolCalls: number,
  emitTrace: (event: TraceEventInput) => void,
  approvalCallback?: ApprovalCallback,
  observeToolResult?: ToolResultObserver
): Promise<string> {
  const toolInstructions = `You may use the enabled tools to complete this node.

Research rules:
- If the task asks you to research, investigate, verify, or use public/current information, use web_search or fetch_url before finalizing.
- Prefer real source-page URLs over search-result pages.
- After searching, fetch promising source pages when fetch_url is enabled.
- Do not expose internal tool calls in the final answer.
- If evidence is weak, say what was not verified.`;

  const messages: OpenAIMessage[] = [
    { role: "developer", content: `${systemPrompt}\n\n---\n\n${toolInstructions}` },
    { role: "user", content: userMessage },
  ];
  const tools = getAgentToolSchemas(allowedTools);
  let toolCallsUsed = 0;

  while (toolCallsUsed < maxToolCalls) {
    emitTrace({ kind: "node:model", level: "info", message: `Model call: openai/${model}` });
    const round = await callOpenAIToolRound(model, messages, tools);
    messages.push(round.assistantMessage);

    if (round.toolCalls.length === 0) {
      const finalOutput = round.content || "";
      emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: finalOutput.slice(0, 240) } });
      return finalOutput;
    }

    for (const call of round.toolCalls) {
      if (toolCallsUsed >= maxToolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "Tool limit reached. Provide a final answer from the available information.",
        });
        continue;
      }

      const toolName = call.name as AgentToolName;
      toolCallsUsed += 1;
      if (!allowedTools.includes(toolName)) {
        const denied = `Tool denied: "${call.name}" is not enabled for this node.`;
        emitTrace({ kind: "node:tool-error", level: "warn", message: `Tool denied: ${call.name}`, data: { toolName: call.name, args: call.args } });
        messages.push({ role: "tool", tool_call_id: call.id, content: denied });
        continue;
      }

      emitTrace({ kind: "node:tool-call", level: "info", message: `Calling ${toolName}`, data: { toolName, args: call.args } });
      try {
        const result = await executeAgentTool(toolName, call.args, approvalCallback);
        emitTrace({
          kind: "node:tool-result",
          level: "info",
          message: `${toolName} completed`,
          data: { toolName, result: result.slice(0, 12000), preview: result.slice(0, 240) },
        });
        observeToolResult?.({ toolName, args: call.args, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = `Tool error: ${message}`;
        emitTrace({ kind: "node:tool-error", level: "error", message: `${toolName} failed`, data: { toolName, error: message } });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  }

  messages.push({
    role: "user",
    content: "The maximum number of tool calls for this node has been reached. Provide the best final answer from the available information. Do not include raw tool call JSON.",
  });
  emitTrace({ kind: "node:model", level: "info", message: `Final model call: openai/${model}` });
  const finalRound = await callOpenAIToolRound(model, messages, []);
  const finalOutput = finalRound.content || "";
  emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: finalOutput.slice(0, 240) } });
  return finalOutput;
}

function firstEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function resolveOpenAIWebSearchModel(requestedModel: string): string {
  const configured = firstEnv("OPENAI_SEARCH_MODEL", "OPENAI_RESPONSES_MODEL", "OPENAI_DEFAULT_MODEL");
  if (configured) return configured;

  const trimmed = requestedModel.trim();
  if (!trimmed || trimmed === "gpt-5.5") return "gpt-4o";
  return trimmed;
}

function shouldRetryWithPreview(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /400|invalid|unsupported|unknown.*tool|tool.*not/i.test(message);
}

function errorTraceData(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const cause = err.cause instanceof Error
    ? { name: err.cause.name, message: err.cause.message }
    : err.cause
      ? { cause: String(err.cause) }
      : undefined;
  return {
    error: err.message,
    name: err.name,
    ...(cause ? { cause } : {}),
  };
}

async function callOpenAIWebSearch(
  requestedModel: string,
  systemPrompt: string,
  userMessage: string,
  emitTrace: (event: TraceEventInput) => void
): Promise<OpenAIResponsesResult> {
  const model = resolveOpenAIWebSearchModel(requestedModel);
  const attempts: OpenAIWebSearchTool[] = ["web_search"];
  let lastError: unknown = null;

  for (const searchTool of attempts) {
    emitTrace({
      kind: "node:model",
      level: "info",
      message: `Responses API search: openai/${model}`,
      data: { requestedModel, model, searchTool },
    });
    emitTrace({
      kind: "node:tool-call",
      level: "info",
      message: `Calling ${searchTool}`,
      data: { toolName: searchTool },
    });
    try {
      const result = await callOpenAIResponses({ model, systemPrompt, userMessage, searchTool });
      if (!result.content.trim()) {
        throw new Error("OpenAI Responses API returned an empty search answer");
      }
      return result;
    } catch (err) {
      lastError = err;
      emitTrace({
        kind: "node:tool-error",
        level: "warn",
        message: `${searchTool} failed`,
        data: { toolName: searchTool, ...errorTraceData(err) },
      });
      if (searchTool === "web_search" && shouldRetryWithPreview(err)) {
        attempts.push("web_search_preview");
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callAIWithTools(
  model: string,
  systemPrompt: string,
  userMessage: string,
  allowedTools: AgentToolName[],
  maxToolCalls: number,
  emitTrace: (event: TraceEventInput) => void,
  approvalCallback?: ApprovalCallback,
  observeToolResult?: ToolResultObserver
): Promise<string> {
  if (allowedTools.length === 0 || maxToolCalls <= 0) {
    emitTrace({ kind: "node:model", level: "info", message: `Model call: openai/${model}` });
    return callOpenAI(model, systemPrompt, userMessage);
  }

  if (allowedTools.includes("web_search")) {
    const searchModel = resolveOpenAIWebSearchModel(model);
    try {
      const result = await callOpenAIWebSearch(model, systemPrompt, userMessage, emitTrace);
      emitTrace({
        kind: "node:tool-result",
        level: "info",
        message: `${result.searchTool} completed`,
        data: {
          toolName: result.searchTool,
          model: result.model,
          sourceCount: result.sources.length,
          sources: result.sources.slice(0, 12),
          preview: result.content.slice(0, 240),
        },
      });
      observeToolResult?.({
        toolName: result.searchTool,
        result: result.content,
        sources: result.sources,
      });
      emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: result.content.slice(0, 240) } });
      return result.content;
    } catch (err) {
      emitTrace({
        kind: "node:tool-error",
        level: "warn",
        message: "Native web search failed; falling back to function tools",
        data: { fallbackModel: searchModel, ...errorTraceData(err) },
      });
      return callOpenAIWithNativeTools(
        searchModel,
        systemPrompt,
        userMessage,
        allowedTools,
        maxToolCalls,
        emitTrace,
        approvalCallback,
        observeToolResult
      );
    }
  }

  return callOpenAIWithNativeTools(model, systemPrompt, userMessage, allowedTools, maxToolCalls, emitTrace, approvalCallback, observeToolResult);
}

function buildGraph(
  nodes: Map<string, ServerNode>,
  edges: Map<string, ServerEdge>
): Map<string, Array<{ targetId: string; sourcePort: string }>> {
  const graph = new Map<string, Array<{ targetId: string; sourcePort: string }>>();
  for (const node of nodes.values()) graph.set(node.id, []);
  for (const edge of edges.values()) {
    if (!isFlowEdge(edge, nodes)) continue;
    const list = graph.get(edge.sourceId);
    if (list) list.push({ targetId: edge.targetId, sourcePort: edge.sourcePort ?? "default" });
  }
  return graph;
}

function edgeKind(edge: ServerEdge, nodes: Map<string, ServerNode>): EdgeKind {
  if (edge.edgeKind === "context" || edge.edgeKind === "flow") return edge.edgeKind;
  const source = nodes.get(edge.sourceId);
  return source?.typeId === "context" ? "context" : "flow";
}

function isFlowEdge(edge: ServerEdge, nodes: Map<string, ServerNode>): boolean {
  if (edgeKind(edge, nodes) !== "flow") return false;
  const source = nodes.get(edge.sourceId);
  const target = nodes.get(edge.targetId);
  return Boolean(source && target && source.typeId !== "context" && target.typeId !== "context");
}

function isContextEdge(edge: ServerEdge, nodes: Map<string, ServerNode>): boolean {
  if (edgeKind(edge, nodes) !== "context") return false;
  const source = nodes.get(edge.sourceId);
  const target = nodes.get(edge.targetId);
  return Boolean(source && target && source.typeId === "context" && target.typeId !== "context");
}

function findStartNode(nodes: Map<string, ServerNode>): ServerNode | null {
  return Array.from(nodes.values()).find((n) => n.typeId === "start") ?? null;
}

function evaluateCondition(condition: string, output: string): boolean {
  const t = condition.trim();
  const lower = output.toLowerCase();

  // ── Shorthand keywords (most useful for dev workflows) ──────────────────
  // "success" / "passed" — output looks like a successful run
  if (t === "success" || t === "passed") {
    return !lower.includes("error") && !lower.includes("failed") && !lower.includes("fail\n");
  }
  // "failure" / "failed" — output indicates a failure
  if (t === "failure" || t === "failed" || t === "error") {
    return lower.includes("error") || lower.includes("failed") || lower.includes("fail\n");
  }
  // "exit:0" — shell command exited cleanly
  if (/^exit:\s*0$/.test(t)) return output.includes("exitCode: 0") || output.includes('"exitCode":0');
  // "exit:!0" — shell command exited with non-zero code
  if (/^exit:!0$|^exit:\s*non-?zero$/i.test(t)) {
    return !output.includes("exitCode: 0") && !output.includes('"exitCode":0') &&
           /exit[Cc]ode[":]\s*[1-9]/.test(output);
  }

  // ── output.includes("str") or !output.includes("str") ──────────────────
  const includesM = /^(!?)output\.includes\(["'](.*)["']\)$/.exec(t);
  if (includesM) {
    const r = output.includes(includesM[2]);
    return includesM[1] === "!" ? !r : r;
  }

  // ── output.startsWith / endsWith ────────────────────────────────────────
  const startsM = /^(!?)output\.startsWith\(["'](.*)["']\)$/.exec(t);
  if (startsM) { const r = output.startsWith(startsM[2]); return startsM[1] === "!" ? !r : r; }

  const endsM = /^(!?)output\.endsWith\(["'](.*)["']\)$/.exec(t);
  if (endsM) { const r = output.endsWith(endsM[2]); return endsM[1] === "!" ? !r : r; }

  // ── output.length <op> N ────────────────────────────────────────────────
  const lenM = /^output\.length\s*([><=!]+)\s*(\d+)$/.exec(t);
  if (lenM) {
    const n = Number(lenM[2]);
    switch (lenM[1]) {
      case ">":   return output.length > n;
      case "<":   return output.length < n;
      case ">=":  return output.length >= n;
      case "<=":  return output.length <= n;
      case "===": return output.length === n;
      case "!==": return output.length !== n;
    }
  }

  // ── contains:"str" shorthand ─────────────────────────────────────────────
  const containsM = /^(!?)contains:\s*["']?(.+?)["']?$/.exec(t);
  if (containsM) {
    const r = lower.includes(containsM[2].toLowerCase());
    return containsM[1] === "!" ? !r : r;
  }

  if (t === "true") return true;
  if (t === "false") return false;
  return false;
}

const AI_STEP_TYPES = new Set(["agent"]);

interface ContextPayload {
  nodeId: string;
  label: string;
  sourceType: string;
  url?: string;
  notes: string;
  content: string;
  spreadToChain: boolean;
}

async function resolveContextNode(node: ServerNode): Promise<ContextPayload> {
  const sourceType = (node.config.sourceType as string) || "text";
  const notes = (node.config.notes as string) || "";
  const spreadToChain = Boolean(node.config.spreadToChain);
  let content = "";

  if (sourceType === "text") {
    content = (node.config.content as string) || "";
  } else if (sourceType === "url") {
    const url = (node.config.url as string) || "";
    if (url) {
      const res = await fetch(url, { headers: { "User-Agent": "dispatch-ai/1.0" } });
      let text = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("html")) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
      content = text.length > 12000 ? text.slice(0, 12000) + "\n[… truncated]" : text;
    }
  } else if (sourceType === "search") {
    const query = (node.config.searchQuery as string) || "";
    if (query) {
      content = await webSearch(query);
    }
  } else if (sourceType === "file") {
    const filePath = (node.config.filePath as string) || "";
    if (filePath) {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(resolveWorkspacePath(filePath), "utf-8");
      content = text.length > 10000 ? text.slice(0, 10000) + "\n[… truncated]" : text;
    }
  }

  return {
    nodeId: node.id,
    label: node.label || "Context",
    sourceType,
    url: typeof node.config.url === "string" ? node.config.url : undefined,
    notes,
    content,
    spreadToChain,
  };
}

function buildSystemPrompt(role: string, taskDescription: string, contextNotes?: string): string {
  const parts: string[] = [];

  // The editable node prompt is task input. System instructions stay internal
  // so each role can behave like a reusable skill.
  const primary = getSkillPrompt(role);
  if (primary) parts.push(primary);

  if (taskDescription) parts.push(`## Task Goal\n${taskDescription}`);
  if (contextNotes) parts.push(`## Provided Context\n${contextNotes}`);

  return parts.join("\n\n---\n\n");
}

function buildUserMessage(inputText: string, taskPrompt: string, contextContent: string, ledgerContext: string): string {
  const sections: string[] = [];
  const trimmedInput = inputText.trim();
  const trimmedTask = taskPrompt.trim();

  if (contextContent) sections.push(`[Provided Context]\n${contextContent}`);
  if (ledgerContext) sections.push(`[Run Ledger]\n${ledgerContext}`);
  if (trimmedInput && !(trimmedTask && trimmedInput === "No task defined.")) {
    sections.push(`[Chain Input]\n${trimmedInput}`);
  }
  if (trimmedTask) sections.push(`[Task At Hand]\n${trimmedTask}`);

  return sections.join("\n\n---\n\n") || trimmedInput || trimmedTask || "Continue the workflow.";
}

function firstNonBlank(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function numberConfig(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function contentLooksLikeHtml(content: string): boolean {
  return /<!doctype html|<html[\s>]|<body[\s>]|<main[\s>]/i.test(content);
}

function artifactMimeType(content: string): string | undefined {
  return contentLooksLikeHtml(content) ? "text/html" : undefined;
}

async function repairArtifactIfNeeded(params: {
  node: ServerNode;
  model: string;
  artifact: string;
  ledger: RunLedger;
  emitTrace: (event: TraceEventInput) => void;
  maxRepairRounds: number;
}): Promise<{ artifact: string; issues: string[]; repaired: boolean }> {
  const hasSourceEvidence = params.ledger.facts.length > 0 || params.ledger.sources.length > 0;
  let artifact = stripSingleMarkdownFence(params.artifact);
  let issues = artifactQualityIssues(artifact, hasSourceEvidence);
  let repaired = artifact !== params.artifact;

  for (let round = 1; issues.length > 0 && round <= params.maxRepairRounds; round += 1) {
    recordRepair(params.ledger, {
      nodeId: params.node.id,
      round,
      issues,
    });
    params.emitTrace({
      kind: "repair:started",
      level: "warn",
      message: `Repair round ${round}`,
      data: { issues },
    });

    const systemPrompt = [
      "You repair generated website/code artifacts.",
      "Return only the corrected raw artifact.",
      "Do not wrap the artifact in markdown fences.",
      "Do not use generic placeholders when source evidence is available.",
    ].join("\n");
    const userMessage = [
      `Quality issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
      `Run ledger:\n${buildLedgerSummary(params.ledger, 5000) || "(No ledger facts recorded.)"}`,
      `Current artifact:\n${artifact.slice(0, 24000)}`,
    ].join("\n\n---\n\n");

    const repairedArtifact = await callOpenAI(params.model, systemPrompt, userMessage);
    artifact = stripSingleMarkdownFence(repairedArtifact);
    issues = artifactQualityIssues(artifact, hasSourceEvidence);
    repaired = true;

    params.emitTrace({
      kind: "repair:completed",
      level: issues.length === 0 ? "info" : "warn",
      message: `Repair round ${round} ${issues.length === 0 ? "passed" : "still has issues"}`,
      data: { issues },
    });
  }

  return { artifact, issues, repaired };
}

export async function runChain(
  nodes: Map<string, ServerNode>,
  edges: Map<string, ServerEdge>,
  callbacks: ChainCallbacks
): Promise<RunLedger> {
  const { onNodeStatus, waitForReview } = callbacks;
  const graph = buildGraph(nodes, edges);

  const startNode = findStartNode(nodes);
  if (!startNode) throw new Error("No Start node found in chain");

  const taskDescription = (startNode.config.taskDescription as string) || "";
  const defaultModel = firstNonBlank(startNode.config.defaultModel, process.env.OPENAI_DEFAULT_MODEL, "gpt-4o");
  const ledger = createRunLedger(callbacks.runId ?? `run_${Date.now().toString(36)}`, taskDescription);

  // --- Context node pre-pass: resolve all context nodes before chain runs ---
  const contextNodes = Array.from(nodes.values()).filter((n) => n.typeId === "context");
  const resolvedContexts = await Promise.all(
    contextNodes.map(async (n) => {
      onNodeStatus(n.id, "running");
      try {
        const payload = await resolveContextNode(n);
        const preview = payload.content
          ? `Resolved ${payload.sourceType} context${payload.url ? ` from ${payload.url}` : ""}.\n\n${payload.content.slice(0, 1200)}`
          : `Resolved ${payload.sourceType} context with no extractable content.`;
        onNodeStatus(n.id, "done", preview);
        return payload;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onNodeStatus(n.id, "error", `Context error: ${msg}`);
        return null;
      }
    })
  );
  const validContexts = resolvedContexts.filter((p): p is ContextPayload => p !== null);
  for (const payload of validContexts) {
    const source = addLedgerSource(ledger, {
      nodeId: payload.nodeId,
      kind: "context",
      label: payload.label,
      url: payload.sourceType === "url" ? payload.url : undefined,
    });
    const fact = addLedgerFact(ledger, {
      nodeId: payload.nodeId,
      sourceId: source.id,
      kind: "context",
      title: payload.sourceType === "url" && payload.url
        ? `Resolved URL context: ${payload.url}`
        : `Resolved ${payload.sourceType} context`,
      content: payload.content || payload.notes || "(Context resolved with no content.)",
      confidence: payload.content ? "high" : "low",
    });
    callbacks.onNodeTrace?.(payload.nodeId, {
      kind: "ledger:fact-added",
      level: payload.content ? "info" : "warn",
      message: "Context added to run ledger",
      data: {
        factId: fact.id,
        sourceId: source.id,
        sourceType: payload.sourceType,
        preview: fact.content.slice(0, 500),
      },
    });
  }

  // Build direct injection map: targetNodeId → [ContextPayload]
  const contextFor = new Map<string, ContextPayload[]>();
  for (const payload of validContexts) {
    for (const edge of edges.values()) {
      if (edge.sourceId !== payload.nodeId || !isContextEdge(edge, nodes)) continue;
      if (!contextFor.has(edge.targetId)) contextFor.set(edge.targetId, []);
      contextFor.get(edge.targetId)!.push(payload);
    }
  }

  // Propagate spread contexts downstream via BFS
  for (const [targetId, contexts] of Array.from(contextFor.entries())) {
    const spreading = contexts.filter((c) => c.spreadToChain);
    if (spreading.length === 0) continue;
    const seen = new Set<string>();
    const queue = [targetId];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (nodeId !== targetId) {
        if (!contextFor.has(nodeId)) contextFor.set(nodeId, []);
        const existing = contextFor.get(nodeId)!;
        for (const ctx of spreading) {
          if (!existing.includes(ctx)) existing.push(ctx);
        }
      }
      for (const edge of (graph.get(nodeId) ?? [])) queue.push(edge.targetId);
    }
  }

  const visited = new Set<string>();
  const chainMemory = new Map<string, string>(); // key-value store scoped to this run

  // BFS/DFS execution — follows edges from start
  async function executeNode(nodeId: string, inputText: string): Promise<void> {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodes.get(nodeId);
    if (!node) return;

    const emitTrace = (event: TraceEventInput) => callbacks.onNodeTrace?.(nodeId, event);
    emitTrace({
      kind: "node:started",
      level: "info",
      message: `Started ${node.label || node.typeId}`,
      data: { typeId: node.typeId, label: node.label },
    });
    if (inputText.trim()) {
      emitTrace({
        kind: "node:input",
        level: "debug",
        message: "Received input",
        data: { preview: inputText.slice(0, 500), length: inputText.length },
      });
    }
    onNodeStatus(nodeId, "running");

    let output = "";
    let nextPort = "default";

    try {
      if (node.typeId === "start") {
        // Start node: output is the task description
        output = taskDescription || "No task defined.";

      } else if (AI_STEP_TYPES.has(node.typeId)) {
        // Agent step — role selects the internal skill; taskPrompt is sent as user/task input.
        const model = firstNonBlank(node.config.model, defaultModel);
        const role = (node.config.role as string) || "investigate";
        const taskPrompt = firstNonBlank(node.config.taskPrompt, node.config.systemPrompt);
        const allowedTools = normalizeAllowedAgentTools(node.config.tools);
        const maxToolCalls = Math.max(0, Math.min(Number(node.config.maxToolCalls) || 6, 20));

        const injections = contextFor.get(nodeId) ?? [];
        const contextNotesSections = injections
          .filter((c) => c.notes)
          .map((c) => `### Context Note\n${c.notes}`)
          .join("\n\n") || undefined;
        const contentPrepend = injections
          .filter((c) => c.content)
          .map((c) => c.content)
          .join("\n\n---\n\n");
        const observeToolResult: ToolResultObserver = (record) => {
          const sourceIds: string[] = [];
          for (const source of (record.sources ?? []).slice(0, 12)) {
            const url = typeof source.url === "string" ? source.url : undefined;
            const title = typeof source.title === "string" ? source.title : record.toolName;
            const ledgerSource = addLedgerSource(ledger, {
              nodeId,
              kind: "tool",
              label: title,
              url,
            });
            sourceIds.push(ledgerSource.id);
          }

          if (sourceIds.length === 0) {
            const url = typeof record.args?.url === "string" ? record.args.url : undefined;
            const query = typeof record.args?.query === "string" ? record.args.query : "";
            const ledgerSource = addLedgerSource(ledger, {
              nodeId,
              kind: "tool",
              label: query ? `${record.toolName}: ${query}` : record.toolName,
              url,
            });
            sourceIds.push(ledgerSource.id);
          }

          const fact = addLedgerFact(ledger, {
            nodeId,
            sourceId: sourceIds[0],
            kind: "research",
            title: `${record.toolName} result`,
            content: record.result,
            confidence: "medium",
          });
          emitTrace({
            kind: "ledger:fact-added",
            level: "info",
            message: `${record.toolName} result added to run ledger`,
            data: {
              factId: fact.id,
              sourceIds,
              preview: record.result.slice(0, 500),
            },
          });
        };

        const systemPrompt = buildSystemPrompt(role, taskDescription, contextNotesSections);
        const ledgerSummary = buildLedgerSummary(ledger);

        if (role === "evaluate" && node.config.passThroughArtifact === true) {
          const maxRepairRounds = Math.max(0, Math.min(numberConfig(node.config.maxRepairRounds, 2), 4));
          const repaired = await repairArtifactIfNeeded({
            node,
            model,
            artifact: inputText,
            ledger,
            emitTrace,
            maxRepairRounds: node.config.autoRepair === false ? 0 : maxRepairRounds,
          });
          const verdict = repaired.issues.length > 0 ? "fail" : "pass";
          const evaluation = recordEvaluation(ledger, {
            nodeId,
            verdict,
            issues: repaired.issues,
          });
          if (repaired.issues.length > 0) {
            emitTrace({
              kind: "evaluation:failed",
              level: "error",
              message: "Artifact failed quality gates",
              data: { evaluationId: evaluation.id, issues: repaired.issues },
            });
            throw new Error(`Artifact failed quality gates: ${repaired.issues.join("; ")}`);
          }
          output = repaired.artifact;
        } else {
          const userMessage = buildUserMessage(inputText, taskPrompt, contentPrepend, ledgerSummary);
          output = await callAIWithTools(
            model,
            systemPrompt,
            userMessage,
            allowedTools,
            maxToolCalls,
            emitTrace,
            callbacks.requestToolApproval,
            observeToolResult
          );

          if (role === "create" || node.config.outputMode === "raw-artifact") {
            const maxRepairRounds = Math.max(0, Math.min(numberConfig(node.config.maxRepairRounds, 2), 4));
            const repaired = await repairArtifactIfNeeded({
              node,
              model,
              artifact: output,
              ledger,
              emitTrace,
              maxRepairRounds: node.config.autoRepair === false ? 0 : maxRepairRounds,
            });
            output = repaired.artifact;
            if (repaired.issues.length > 0) {
              const evaluation = recordEvaluation(ledger, {
                nodeId,
                verdict: "fail",
                issues: repaired.issues,
              });
              emitTrace({
                kind: "evaluation:failed",
                level: "error",
                message: "Created artifact failed quality gates",
                data: { evaluationId: evaluation.id, issues: repaired.issues },
              });
              throw new Error(`Created artifact failed quality gates: ${repaired.issues.join("; ")}`);
            }
          }
        }

      } else if (node.typeId === "review") {
        // Pause and wait for human decision
        onNodeStatus(nodeId, "paused");
        emitTrace({ kind: "review:waiting", level: "info", message: "Waiting for review decision" });
        const decision = await waitForReview(nodeId);
        emitTrace({
          kind: "review:decision",
          level: decision === "approved" ? "info" : "warn",
          message: `Review ${decision}`,
          data: { decision },
        });
        nextPort = decision === "approved" ? "approved" : "rejected";
        output = decision === "approved" ? "Approved by reviewer." : "Rejected by reviewer.";
        onNodeStatus(nodeId, "done", output);

      } else if (node.typeId === "fork") {
        // Pass-through: fans input to all connected nodes in parallel
        output = inputText;

      } else if (node.typeId === "branch") {
        // AI evaluates a natural-language condition
        const condition = (node.config.condition as string) || "false";
        const model = firstNonBlank(node.config.model, defaultModel);
        const evalSystem = `You are a condition evaluator. Given the output of a previous step and a condition to check, respond with ONLY the word "true" or "false" (lowercase, no punctuation, nothing else).`;
        const evalUser = `Previous output:\n${inputText}\n\nCondition to evaluate: ${condition}`;
        const evalResult = await callOpenAI(model, evalSystem, evalUser);
        const boolResult = evalResult.trim().toLowerCase().startsWith("true");
        nextPort = boolResult ? "true" : "false";
        output = `Condition "${condition}" → ${boolResult ? "true ✓" : "false ✗"}`;

      } else if (node.typeId === "tool") {
        // HTTP tool call
        const url = (node.config.url as string) || "";
        const method = ((node.config.method as string) || "GET").toUpperCase();
        if (!url) throw new Error("Tool node has no URL configured");
        const res = await fetch(url, {
          method,
          headers: JSON.parse((node.config.headers as string) || "{}") as Record<string, string>,
          body: method !== "GET" && node.config.body ? String(node.config.body) : undefined,
        });
        output = await res.text();

      } else if (node.typeId === "memory") {
        const operation = (node.config.operation as string) || "read";
        const key = (node.config.key as string) || "default";
        if (operation === "write") {
          chainMemory.set(key, inputText);
          callbacks.writeWorkspaceMemory?.(key, inputText);
          output = inputText; // pass through so the chain can continue
        } else {
          output = callbacks.readWorkspaceMemory?.(key) ?? chainMemory.get(key) ?? `(memory key "${key}" is empty)`;
        }

      } else if (node.typeId === "shell-exec") {
        const command = (node.config.command as string) || "";
        if (!command) throw new Error("Shell Execute node has no command configured");
        const workdir = resolveWorkspacePath((node.config.workdir as string) || ".");
        const timeout = Number(node.config.timeout) || 30000;
        const fmt = (node.config.outputFormat as string) || "text";

        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);

        let stdout = "", stderr = "", exitCode = 0;
        try {
          const result = await execAsync(command, { cwd: workdir, timeout });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (err: unknown) {
          const execErr = err as { stdout?: string; stderr?: string; code?: number };
          stdout = execErr.stdout ?? "";
          stderr = execErr.stderr ?? "";
          exitCode = execErr.code ?? 1;
        }

        if (fmt === "json") {
          output = JSON.stringify({ stdout, stderr, exitCode }, null, 2);
        } else {
          const parts: string[] = [];
          if (stdout) parts.push(`stdout:\n${stdout}`);
          if (stderr) parts.push(`stderr:\n${stderr}`);
          parts.push(`exitCode: ${exitCode}`);
          output = parts.join("\n\n");
        }

      } else if (node.typeId === "file-write") {
        const filePath = (node.config.path as string) || "";
        if (!filePath.trim()) throw new Error("File Write node has no path configured");
        const resolvedFilePath = resolveWorkspacePath(filePath);
        const mode = (node.config.mode as string) || "write";
        const contentToWrite = stripMarkdownFenceForPath(filePath, inputText);
        const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(resolvedFilePath), { recursive: true });
        if (mode === "append") {
          await appendFile(resolvedFilePath, contentToWrite, "utf-8");
        } else {
          await writeFile(resolvedFilePath, contentToWrite, "utf-8");
        }
        const artifact = recordArtifact(ledger, {
          nodeId,
          title: path.basename(filePath),
          content: contentToWrite,
          path: filePath,
          mimeType: artifactMimeType(contentToWrite),
        });
        emitTrace({
          kind: "artifact:created",
          level: "info",
          message: `Artifact written to ${filePath}`,
          data: { artifactId: artifact.id, path: filePath, length: contentToWrite.length },
        });
        output = `Written ${contentToWrite.length} chars to ${resolvedFilePath}`;
      }

      if (node.typeId !== "review") {
        const role = typeof node.config.role === "string" ? node.config.role : undefined;
        recordNodeOutput(ledger, {
          nodeId,
          role,
          label: node.label || node.typeId,
          output,
        });

        if (output.trim() && node.typeId !== "file-write") {
          const fact = addLedgerFact(ledger, {
            nodeId,
            kind: "output",
            title: `${node.label || node.typeId} output`,
            content: output,
            confidence: "medium",
          });
          emitTrace({
            kind: "ledger:fact-added",
            level: "debug",
            message: "Node output added to run ledger",
            data: { factId: fact.id, preview: output.slice(0, 500) },
          });
        }

        if (node.typeId === "agent" && (role === "create" || node.config.outputMode === "raw-artifact")) {
          const artifact = recordArtifact(ledger, {
            nodeId,
            title: node.label || "Created artifact",
            content: output,
            mimeType: artifactMimeType(output),
          });
          emitTrace({
            kind: "artifact:created",
            level: "info",
            message: "Artifact created",
            data: { artifactId: artifact.id, length: output.length },
          });
        }

        emitTrace({
          kind: "node:output",
          level: "info",
          message: "Node completed",
          data: { preview: output.slice(0, 500), length: output.length },
        });
        onNodeStatus(nodeId, "done", output);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitTrace({
        kind: "node:error",
        level: "error",
        message,
        data: errorTraceData(err),
      });
      onNodeStatus(nodeId, "error", `Error: ${message}`);
      return; // Stop chain on error
    }

    // Follow edges from this node that match the chosen port.
    // Fall back to "default" edges when no named-port match exists (handles
    // chains where edges were created before port-aware connection was in place).
    const outgoing = graph.get(nodeId) ?? [];
    let matching = outgoing.filter((e) =>
      nextPort === "default"
        ? e.sourcePort === "default" || !e.sourcePort
        : e.sourcePort === nextPort
    );
    if (matching.length === 0 && nextPort !== "default") {
      matching = outgoing.filter((e) => e.sourcePort === "default" || !e.sourcePort);
    }

    // Execute all matching next nodes (parallel fan-out if multiple)
    await Promise.all(matching.map((e) => executeNode(e.targetId, output)));
  }

  await executeNode(startNode.id, "");
  completeRunLedger(ledger);
  return ledger;
}
