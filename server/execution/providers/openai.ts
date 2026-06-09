import type { AgentToolSchema } from "../agentTools.js";

interface OpenAIMessage {
  role: "developer" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenAIToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface OpenAIToolRoundResult {
  content: string;
  toolCalls: OpenAIToolCall[];
  assistantMessage: OpenAIMessage;
}

function safeJsonArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function callOpenAI(
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const maxCompletionTokens = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS ?? 8192);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "developer", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      max_completion_tokens: Number.isFinite(maxCompletionTokens) ? maxCompletionTokens : 8192,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

export async function callOpenAIToolRound(
  model: string,
  messages: OpenAIMessage[],
  tools: AgentToolSchema[]
): Promise<OpenAIToolRoundResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const maxCompletionTokens = Number(process.env.OPENAI_MAX_COMPLETION_TOKENS ?? 8192);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
      max_completion_tokens: Number.isFinite(maxCompletionTokens) ? maxCompletionTokens : 8192,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: OpenAIMessage }>;
  };
  const assistantMessage = data.choices[0]?.message ?? { role: "assistant", content: "" };
  const toolCalls = (assistantMessage.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    args: safeJsonArgs(call.function.arguments),
  }));
  return {
    content: assistantMessage.content ?? "",
    toolCalls,
    assistantMessage,
  };
}

export type { OpenAIMessage };
