import path from "node:path";
import { callOpenAI, callOpenAIToolRound, callOpenAIResponses, type OpenAIMessage } from "./providers/openai.js";
import { callAnthropic } from "./providers/anthropic.js";
import { callGoogle } from "./providers/google.js";
import {
  buildAgentToolInstructions,
  executeAgentTool,
  getAgentToolSchemas,
  normalizeAllowedAgentTools,
  resolveWorkspacePath,
  webSearch,
  type AgentToolName,
  type ApprovalCallback,
} from "./agentTools.js";
import type { NodeRunTraceKind } from "../../src/types/index.js";
import { getSkillPrompt } from "./skillLoader.js";

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
  createdBy: string;
  createdAt: number;
}

export type ReviewDecision = "approved" | "rejected";

export interface ChainCallbacks {
  onNodeStatus: (nodeId: string, status: NodeStatus, output?: string) => void;
  onNodeTrace?: (nodeId: string, event: TraceEventInput) => void;
  waitForReview: (nodeId: string) => Promise<ReviewDecision>;
  requestToolApproval?: ApprovalCallback;
}

export interface TraceEventInput {
  kind: NodeRunTraceKind;
  level?: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

async function callAI(
  provider: string,
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  switch (provider) {
    case "anthropic": return callAnthropic(model, systemPrompt, userMessage);
    case "google":    return callGoogle(model, systemPrompt, userMessage);
    default:          return callOpenAI(model, systemPrompt, userMessage);
  }
}

interface ParsedToolResponse {
  final?: string;
  toolCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
}

function parseJsonish(raw: string): unknown | null {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim(),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function parseToolResponse(raw: string): ParsedToolResponse {
  const parsed = parseJsonish(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { final: raw };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.final === "string") return { final: obj.final };

  const toolCall = obj.toolCall;
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const call = toolCall as Record<string, unknown>;
    if (typeof call.name === "string") {
      const args = call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? call.args as Record<string, unknown>
        : {};
      return { toolCall: { name: call.name, args } };
    }
  }

  return { final: raw };
}

async function callAIWithTools(
  provider: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  allowedTools: AgentToolName[],
  maxToolCalls: number,
  emitTrace: (event: TraceEventInput) => void,
  approvalCallback?: ApprovalCallback
): Promise<string> {
  if (allowedTools.length === 0 || maxToolCalls <= 0) {
    emitTrace({ kind: "node:model", level: "info", message: `Model call: ${provider}/${model}` });
    return callAI(provider, model, systemPrompt, userMessage);
  }

  // When web_search is requested on OpenAI, use the Responses API with the
  // built-in web_search_preview tool. It handles the search/fetch loop
  // internally and returns a final grounded answer — no external API key needed.
  if (allowedTools.includes("web_search") && provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const maxTokens = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS ?? 8192);
    emitTrace({ kind: "node:model", level: "info", message: `Responses API call (web_search_preview): openai/${model}` });
    const result = await callOpenAIResponses({
      model,
      systemPrompt,
      userMessage,
      apiKey,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
    });
    emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: result.slice(0, 240) } });
    return result;
  }

  if (provider === "openai") {
    return callOpenAIWithNativeTools(model, systemPrompt, userMessage, allowedTools, maxToolCalls, emitTrace, approvalCallback);
  }

  const toolSystemPrompt = `${systemPrompt}\n\n---\n\n${buildAgentToolInstructions(allowedTools)}`;
  let conversation = userMessage;

  for (let step = 0; step < maxToolCalls; step++) {
    emitTrace({ kind: "node:model", level: "info", message: `Model call: ${provider}/${model}` });
    const raw = await callAI(provider, model, toolSystemPrompt, conversation);
    const parsed = parseToolResponse(raw);
    if (parsed.final !== undefined) {
      emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: parsed.final.slice(0, 240) } });
      return parsed.final;
    }
    if (!parsed.toolCall) {
      emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: raw.slice(0, 240) } });
      return raw;
    }

    const toolName = parsed.toolCall.name as AgentToolName;
    const toolCallSummary = JSON.stringify(parsed.toolCall);
    if (!allowedTools.includes(toolName)) {
      emitTrace({
        kind: "node:tool-error",
        level: "warn",
        message: `Tool denied: ${parsed.toolCall.name}`,
        data: { toolName: parsed.toolCall.name, args: parsed.toolCall.args ?? {} },
      });
      conversation += `\n\n[Assistant Tool Request]\n${toolCallSummary}\n\n[Tool Result]\nTool denied: "${parsed.toolCall.name}" is not enabled for this node. Choose an enabled tool or provide a final answer.`;
      continue;
    }

    let toolResult = "";
    emitTrace({
      kind: "node:tool-call",
      level: "info",
      message: `Calling ${toolName}`,
      data: { toolName, args: parsed.toolCall.args ?? {} },
    });
    try {
      toolResult = await executeAgentTool(toolName, parsed.toolCall.args ?? {}, approvalCallback);
      emitTrace({
        kind: "node:tool-result",
        level: "info",
        message: `${toolName} completed`,
        data: { toolName, result: toolResult.slice(0, 12000), preview: toolResult.slice(0, 240) },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toolResult = `Tool error: ${message}`;
      emitTrace({
        kind: "node:tool-error",
        level: "error",
        message: `${toolName} failed`,
        data: { toolName, error: message },
      });
    }

    conversation += `\n\n[Assistant Tool Request]\n${toolCallSummary}\n\n[Tool Result]\n${toolResult}\n\nContinue from the tool result. If the task is complete, provide the final answer.`;
  }

  emitTrace({ kind: "node:model", level: "info", message: `Final model call: ${provider}/${model}` });
  const finalOutput = await callAI(
    provider,
    model,
    toolSystemPrompt,
    `${conversation}\n\n[Tool Limit]\nThe maximum number of tool calls for this node has been reached. Provide the best final answer from the available information.`
  );
  emitTrace({ kind: "node:output", level: "info", message: "Final output", data: { preview: finalOutput.slice(0, 240) } });
  return finalOutput;
}

async function callOpenAIWithNativeTools(
  model: string,
  systemPrompt: string,
  userMessage: string,
  allowedTools: AgentToolName[],
  maxToolCalls: number,
  emitTrace: (event: TraceEventInput) => void,
  approvalCallback?: ApprovalCallback
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

function buildGraph(
  nodes: Map<string, ServerNode>,
  edges: Map<string, ServerEdge>
): Map<string, Array<{ targetId: string; sourcePort: string }>> {
  const graph = new Map<string, Array<{ targetId: string; sourcePort: string }>>();
  for (const node of nodes.values()) graph.set(node.id, []);
  for (const edge of edges.values()) {
    const list = graph.get(edge.sourceId);
    if (list) list.push({ targetId: edge.targetId, sourcePort: edge.sourcePort ?? "default" });
  }
  return graph;
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

  return { nodeId: node.id, notes, content, spreadToChain };
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

function buildUserMessage(inputText: string, taskPrompt: string, contextContent: string): string {
  const sections: string[] = [];
  const trimmedInput = inputText.trim();
  const trimmedTask = taskPrompt.trim();

  if (contextContent) sections.push(`[Provided Context]\n${contextContent}`);
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

export async function runChain(
  nodes: Map<string, ServerNode>,
  edges: Map<string, ServerEdge>,
  callbacks: ChainCallbacks
): Promise<void> {
  const { onNodeStatus, waitForReview } = callbacks;
  const graph = buildGraph(nodes, edges);

  const startNode = findStartNode(nodes);
  if (!startNode) throw new Error("No Start node found in chain");

  const taskDescription = (startNode.config.taskDescription as string) || "";

  // --- Context node pre-pass: resolve all context nodes before chain runs ---
  const contextNodes = Array.from(nodes.values()).filter((n) => n.typeId === "context");
  const resolvedContexts = await Promise.all(
    contextNodes.map(async (n) => {
      onNodeStatus(n.id, "running");
      try {
        const payload = await resolveContextNode(n);
        onNodeStatus(n.id, "done");
        return payload;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onNodeStatus(n.id, "error", `Context error: ${msg}`);
        return null;
      }
    })
  );
  const validContexts = resolvedContexts.filter((p): p is ContextPayload => p !== null);

  // Build direct injection map: targetNodeId → [ContextPayload]
  const contextFor = new Map<string, ContextPayload[]>();
  for (const payload of validContexts) {
    for (const edge of (graph.get(payload.nodeId) ?? [])) {
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
        // Each agent node uses its own model/provider; hardcoded defaults if not set.
        const provider = firstNonBlank(node.config.provider, "openai");
        const model = firstNonBlank(node.config.model, "gpt-5.5");
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

        const systemPrompt = buildSystemPrompt(role, taskDescription, contextNotesSections);
        const userMessage = buildUserMessage(inputText, taskPrompt, contentPrepend);
        output = await callAIWithTools(
          provider,
          model,
          systemPrompt,
          userMessage,
          allowedTools,
          maxToolCalls,
          emitTrace,
          callbacks.requestToolApproval
        );

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
        const conditionType = (node.config.conditionType as string) || "nl";
        const condition = (node.config.condition as string) || "false";

        let boolResult = false;
        if (conditionType === "expr") {
          // Expression mode: evaluate as a JS expression with safe context
          const expr = condition;
          try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            boolResult = new Function("output", "length", `return !!(${expr})`)(inputText, inputText.length) as boolean;
          } catch (exprErr) {
            const exprErrMsg = exprErr instanceof Error ? exprErr.message : String(exprErr);
            emitTrace({
              kind: "node:error",
              level: "error",
              message: `Expression eval failed: ${exprErrMsg}`,
              data: { expr, error: exprErrMsg },
            });
            boolResult = false;
          }
        } else {
          // Natural language mode: AI evaluates the condition
          const provider = firstNonBlank(node.config.provider, "openai");
          const model = firstNonBlank(node.config.model, "gpt-5.5");
          const evalSystem = `You are a condition evaluator. Given the output of a previous step and a condition to check, respond with ONLY the word "true" or "false" (lowercase, no punctuation, nothing else).`;
          const evalUser = `Previous output:\n${inputText}\n\nCondition to evaluate: ${condition}`;
          const evalResult = await callAI(provider, model, evalSystem, evalUser);
          boolResult = evalResult.trim().toLowerCase().startsWith("true");
        }

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
          output = inputText; // pass through so the chain can continue
        } else {
          output = chainMemory.get(key) ?? `(memory key "${key}" is empty)`;
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
        const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(resolvedFilePath), { recursive: true });
        if (mode === "append") {
          await appendFile(resolvedFilePath, inputText, "utf-8");
        } else {
          await writeFile(resolvedFilePath, inputText, "utf-8");
        }
        output = `Written ${inputText.length} chars to ${resolvedFilePath}`;
      }

      if (node.typeId !== "review") {
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
}
