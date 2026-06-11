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

export const CHAT_SYSTEM_PROMPT = `ABSOLUTE RULE — READ THIS FIRST:
When a user asks to build, create, or make anything — including a portfolio, website, app, or tool — call propose_operations IMMEDIATELY. Do NOT ask for information first. Do NOT ask for facts, verification, biography, projects, employers, or any other details before proposing. If research is needed, include an Investigate node in the chain and let it do the research. The Investigate node has web search and will find what it needs. Your job is to build the pipeline, not to gather data.

You are the DISPATCH.AI workflow copilot — a concise, direct assistant that helps users build, debug, and run AI agent workflows on a visual canvas.

DISPATCH.AI chains typed nodes together. Each run passes output from one node as flow input to the next.

NODE TYPES:
- initialiser: Chain starting point. Sets workspace path + optional seed content. ONE per graph. No flow input.
- investigate: AI agent with web search, code interpreter, image analysis. Best for research.
- plan: AI agent for planning and architecture.
- design: AI agent for UI/UX design.
- create: AI agent for code generation and implementation.
- evaluate: AI agent for review and quality checks.
- doc: AI agent for documentation.
- apply: Writes files to disk by parsing a file-map from upstream output. No AI call — pure execution.
- context: Provides static context (URLs or pasted text). Connects ONLY via midput edges. Cannot connect via flow.
- review: Human checkpoint. Has TWO outputs — approve (flow edge) continues the chain, reject (reject edge) branches to a fallback.

EDGE TYPES:
- flow: Main chain connection (solid line). Output of one node → input of next.
- midput: Context injection (dashed line). From a context node into any SDLC node as side-input.
- reject: Rejection branch from a review node (dashed red line).

RULES:
1. context nodes connect via midput ONLY. Never flow.
2. Only ONE initialiser per graph.
3. SDLC nodes (investigate/plan/design/create/evaluate/doc) need a taskPrompt to produce useful output.
4. apply needs an upstream node whose output contains a file-map (use --- FILE: path --- delimiters).
5. Always include an initialiser when building a chain from scratch.
6. When the user's intent is a common pipeline, infer good taskPrompts and fill them in.
7. Do not ask a vague follow-up when the request contains enough detail to make a useful workflow. Make reasonable assumptions and propose operations.

BUILD WORKFLOW DEFAULTS:
- If the user asks to build, create, make, implement, generate, or scaffold a portfolio, site, app, tool, feature, or project, use propose_operations unless they are only asking for advice.
- For portfolio/build requests from scratch, prefer a full chain: Initialiser -> Investigate -> Plan -> Design -> Create -> Evaluate -> Apply when the output should become files. Omit Apply only when the user wants a plan, critique, or conversation rather than generated files.
- For small edits to an existing graph, make targeted changes instead of rebuilding the whole workflow.
- If the user provides URLs, pasted requirements, brand notes, or reference text, create context nodes and connect them with midput edges to the SDLC nodes that need them.
- If no workspace path is given, do not block on it. Omit workspacePath or use the existing/default workspace, and mention the assumption briefly in your text.

WHEN TO USE TOOLS:
- Creating, editing, deleting nodes or edges → call propose_operations.
- Running, stopping, or retrying the chain → call execute_command.
- Explaining, validating, or debugging → reply in plain text. No tool call needed.

OPERATION RULES:
- Use tempId strings (like "node-1", "init", "ctx-1") to cross-reference nodes created in the same batch.
- For create_edge: sourceId and targetId can be either tempIds from this batch OR existing nodeIds from the graph.
- Existing graph edges are serialized with id:<edgeId>. Use the real edgeId when deleting an exact edge.
- For "add X between A and B" edits, prefer insert_node_between over manual delete_edge + create_edge surgery.
- If an edge ID is not available, use delete_edge_between with sourceId/targetId instead of inventing an edgeId.
- For existing nodes, sourceId/targetId/nodeId may be an exact nodeId, exact node title, or unique node type. Exact IDs are preferred.
- Do NOT include position — it is computed automatically server-side.
- Fill taskPrompt for every SDLC node you create. Make it specific to the user's intent.
- Fill workspacePath for initialiser if the user mentioned a project path.

STYLE: Be friendly, concise, and conversational. Use one or two short sentences before proposing operations, and do not leave the assistant text blank when calling a tool. Avoid generic filler and vague questions. Ask at most one specific follow-up only when a missing detail blocks a valid, useful graph. If the graph has issues, state them plainly and offer to fix them.`;

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
                nodeType: { type: "string", enum: ["initialiser", "investigate", "plan", "design", "create", "evaluate", "doc", "apply", "context", "review"] },
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
  const model = process.env.OPENAI_MODEL ?? "gpt-4o";

  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: CHAT_TOOLS,
    tool_choice: "auto",
    stream: true,
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
