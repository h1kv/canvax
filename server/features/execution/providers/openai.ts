import type { AgentToolSchema } from "../tools/agentTools.js";

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

export type OpenAIWebSearchTool = "web_search" | "web_search_preview";

export interface OpenAIResponseSource {
  url: string;
  title?: string;
}

export interface OpenAIResponsesResult {
  content: string;
  model: string;
  searchTool: OpenAIWebSearchTool;
  sources: OpenAIResponseSource[];
}

interface ResponsesAnnotation {
  type?: string;
  url?: string;
  title?: string;
}

interface ResponsesSource {
  url?: string;
  title?: string;
}

interface ResponsesAPIOutput {
  type: string;
  content?: Array<{ type: string; text?: string; annotations?: ResponsesAnnotation[] }>;
  text?: string;
}

interface ResponsesAPIResponse {
  output?: ResponsesAPIOutput[];
  output_text?: string;
  sources?: ResponsesSource[];
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function dedupeSources(sources: OpenAIResponseSource[]): OpenAIResponseSource[] {
  const seen = new Set<string>();
  const deduped: OpenAIResponseSource[] = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url)) continue;
    seen.add(source.url);
    deduped.push(source);
  }
  return deduped;
}

function extractResponsesResult(
  data: ResponsesAPIResponse,
  model: string,
  searchTool: OpenAIWebSearchTool
): OpenAIResponsesResult {
  const parts: string[] = [];
  const sources: OpenAIResponseSource[] = [];

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    parts.push(data.output_text);
  }

  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) parts.push(part.text);
        for (const annotation of part.annotations ?? []) {
          if (annotation.url) sources.push({ url: annotation.url, title: annotation.title });
        }
      }
    }
    if (item.text) parts.push(item.text);
  }

  for (const source of data.sources ?? []) {
    if (source.url) sources.push({ url: source.url, title: source.title });
  }

  return {
    content: parts.join("\n\n").trim(),
    model,
    searchTool,
    sources: dedupeSources(sources),
  };
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`OpenAI Responses API timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const withCode = err as Error & { code?: string };
    return withCode.code ? `${err.message} (${withCode.code})` : err.message;
  }
  return String(err);
}

export async function callOpenAIResponses(params: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  searchTool?: OpenAIWebSearchTool;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<OpenAIResponsesResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const searchTool = params.searchTool ?? "web_search";
  const timeoutMs = params.timeoutMs ?? numberFromEnv("OPENAI_RESPONSES_TIMEOUT_MS", 90000);
  const maxTokens = params.maxTokens ?? numberFromEnv("OPENAI_MAX_COMPLETION_TOKENS", 8192);
  const searchContextSize = process.env.OPENAI_SEARCH_CONTEXT_SIZE ?? "medium";
  const timeout = createTimeoutSignal(timeoutMs);

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: timeout.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        tools: [{ type: searchTool, search_context_size: searchContextSize }],
        tool_choice: "auto",
        instructions: params.systemPrompt,
        input: params.userMessage,
        max_output_tokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
      }),
    });
  } catch (err) {
    throw new Error(`OpenAI Responses API fetch failed: ${describeFetchError(err)}`, { cause: err });
  } finally {
    timeout.clear();
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Responses API error ${res.status} ${res.statusText}: ${err}`);
  }

  const data = await res.json() as ResponsesAPIResponse;
  return extractResponsesResult(data, params.model, searchTool);
}
