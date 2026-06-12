import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export const CHAT_SYSTEM_PROMPT = `You are the DISPATCH.AI workflow copilot — a concise, sharp assistant that helps users design, debug, and run AI agent pipelines on a visual canvas.

## When to propose vs. ask

- If you have enough context to build a useful graph — propose it now with propose_operations. Don't gate on missing details you can infer or assume.
- If a critical decision is genuinely ambiguous and you cannot make a good graph without it — ask exactly ONE focused question. Never ask multiple. Never block on optional details.
- For small edits (add a node, delete a node, rewire an edge) — always propose immediately.

## The canvas

Nodes connect with typed edges. Each chain run passes output forward through flow edges. You propose operations; the user reviews and applies them.

## Node types

- initialiser: Chain starting point. Sets workspace path + optional seed content. ONE per graph. No flow input.
- investigate: AI agent with web search and code interpreter. Use for research tasks and unknown facts.
- plan: AI agent for planning and architecture.
- design: AI agent for UI/UX design.
- create: AI agent for code generation and file creation. Output must be a file-map (--- FILE: path --- blocks) for Apply to work.
- evaluate: AI agent for quality review and spec compliance checking.
- doc: AI agent for documentation.
- apply: Writes files to disk by parsing a file-map from upstream output. No AI call — pure execution.
- context: Provides static context (URLs, pasted text). Connects ONLY via midput edges, never flow.
- review: Human checkpoint. TWO outputs — flow edge (approved) continues; reject edge (rejected) routes to a fallback node.
- parallel: Forks execution into N concurrent branches (≥ 2 outgoing flow edges). Each branch receives the same input and runs independently.
- merge: Collects outputs from N parallel branches into one combined input. Must have ≥ 2 incoming flow edges.
- deploy: Integrations node — commits the workspace path and force-pushes to "rapid-deployments", triggering a Vercel deployment. Returns the deployment URL. Place at the end of chains that generate files.

## Edge types

- flow: Main chain connection. Passes output forward.
- midput: Context injection from a context node (dashed line).
- reject: Routes rejected output from a review node to a fallback.

## Graph design principles

- Start every new chain with an Initialiser node.
- Only include nodes the task actually needs — don't add nodes for process theatre.
- Use Investigate when the task involves unknowns, research, or web data.
- Use parallel + merge when two or more independent tasks can run concurrently.
- context nodes connect via midput only, never flow.
- For parallel wiring: create one flow edge from Parallel to each branch start, and one flow edge from each branch end to Merge.
- If a user provides URLs or pasted text, wire a context node via midput to the relevant SDLC node.

## Operation rules

- Use tempId strings (e.g. "init", "node-1", "edge-a") to cross-reference new items within the same batch.
- sourceId/targetId/nodeId can be a tempId, an existing nodeId, an exact node title, or a unique node type. Exact IDs preferred.
- Do NOT include position — computed server-side automatically.
- Fill taskPrompt for every SDLC node (investigate/plan/design/create/evaluate/doc). Be specific.
- Fill workspacePath for initialiser if the user mentioned a project path.
- For "insert X between A and B" edits, use insert_node_between.
- Use delete_edge_between with sourceId/targetId if you don't have the real edgeId.

## When to use tools

- Creating, editing, deleting nodes or edges → propose_operations.
- Running, stopping, or retrying the chain → execute_command.
- Explaining, validating, or debugging → plain text, no tool call.

## Style

- One short sentence before calling a tool. Never leave text blank on a tool call.
- Be direct. No filler. No "Great question!" No "Certainly!".
- If you ask a question, ask exactly one.`;

const CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "propose_operations",
      description: "Propose typed canvas operations. The server validates them, then shows a confirm card to the user before applying.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Short plain-English description shown to the user in the confirm card (e.g. 'Create portfolio build chain: Initialiser -> Investigate -> Plan -> Design -> Create -> Evaluate -> Apply').",
          },
          operations: {
            type: "array",
            description: "Ordered operations to apply. Use tempId strings to cross-reference new nodes in this batch.",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["create_node", "update_node", "delete_node", "create_edge", "delete_edge", "delete_edge_between", "insert_node_between"] },
                tempId: { type: "string", description: "Your invented ID for this op (required for create_node, create_edge, and insert_node_between). Used to reference created items inside this batch." },
                nodeType: { type: "string", enum: ["initialiser", "investigate", "plan", "design", "create", "evaluate", "doc", "apply", "context", "review", "parallel", "merge", "deploy"] },
                title: { type: "string", description: "Display name for the node." },
                config: {
                  type: "object",
                  properties: {
                    workspacePath: { type: "string" },
                    taskPrompt: { type: "string", description: "What this SDLC node should do. Be specific." },
                    content: { type: "string", description: "For context nodes: URLs/pasted text. For initialiser nodes: the original user request and verified seed facts." },
                  },
                  additionalProperties: false,
                },
                nodeId: { type: "string", description: "Existing nodeId from the graph, exact node title, or unique node type (for update_node or delete_node)." },
                edgeId: { type: "string", description: "Existing edgeId from the graph. Never invent one." },
                sourceId: { type: "string", description: "For create_edge/delete_edge_between/insert_node_between: tempId from this batch, existing nodeId, exact node title, or unique node type." },
                targetId: { type: "string", description: "For create_edge/delete_edge_between/insert_node_between: tempId from this batch, existing nodeId, exact node title, or unique node type." },
                kind: { type: "string", enum: ["flow", "midput", "reject"] },
              },
              required: ["op"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "operations"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Trigger a chain control action.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", enum: ["run_chain", "stop_chain", "retry_from_node"] },
          nodeId: { type: "string", description: "Required for retry_from_node. Use the nodeId from the graph context." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

export interface ChatCallResult {
  text: string;
  toolName?: string;
  toolArgs?: unknown;
}

export async function callChatModel(
  messages: ChatCompletionMessageParam[],
  onChunk: (text: string) => void
): Promise<ChatCallResult> {
  const client = getClient();
  const model = process.env.OPENAI_MODEL ?? "o4-mini";
  const isReasoningModel = /^o\d/.test(model);

  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: CHAT_TOOLS,
    tool_choice: "auto",
    stream: true,
    ...(!isReasoningModel ? { temperature: 0.3 } : {}),
  });

  let fullText = "";
  let toolName: string | undefined;
  let toolArgsJson = "";

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      fullText += delta.content;
      onChunk(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) toolName = tc.function.name;
        if (tc.function?.arguments) toolArgsJson += tc.function.arguments;
      }
    }
  }

  let toolArgs: unknown;
  if (toolArgsJson) {
    try { toolArgs = JSON.parse(toolArgsJson); } catch { /* malformed — ignore */ }
  }

  return { text: fullText, toolName, toolArgs };
}

export type { ChatCompletionMessageParam };
