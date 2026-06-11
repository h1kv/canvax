import OpenAI from "openai";
import type { Tool } from "openai/resources/responses/responses.js";
import { resolveContent } from "./fetchUtils.js";
import type { SkillMeta } from "../../../shared/types.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set in environment");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export interface CallModelParams {
  systemPrompt: string;
  userMessage: string;
  meta?: SkillMeta;
  onProgress?: (msg: string) => void;
}

// Legacy alias kept for any callers that haven't been migrated yet
export type CallOpenAIParams = CallModelParams;

export async function callModel(params: CallModelParams): Promise<string> {
  const meta = params.meta ?? {};
  const tools = meta.tools ?? [];

  if (tools.includes("file_tools")) {
    return callModelWithFileTools(params);
  }
  if (tools.includes("web_search")) {
    return callModelWithTools(params);
  }
  return callModelPlain(params);
}

function supportsTemperature(model: string): boolean {
  return !model.startsWith("gpt-5") && model !== "chat-latest" && model !== "o1" && model !== "o3";
}

async function callModelPlain(params: CallModelParams): Promise<string> {
  const meta = params.meta ?? {};
  const model = meta.model ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
  const client = getClient();

  const response = await client.chat.completions.create({
    model,
    temperature: supportsTemperature(model) ? meta.temperature : undefined,
    max_tokens: meta.maxTokens,
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function analyzeImage(url: string): Promise<string> {
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const ct = head?.headers.get("content-type") ?? "";
    if (head && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
      return await resolveContent(url);
    }

    const client = getClient();
    const model = process.env.OPENAI_MODEL ?? "gpt-5.5";

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in detail. Include all visible text, objects, people, colors, and any notable features." },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
    });

    return `[Image analysis: ${url}]\n${response.choices[0]?.message?.content ?? "No description available"}`;
  } catch (err) {
    return `[analyze_image error: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function exploreWebsite(url: string): Promise<string> {
  return resolveContent(url);
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const INVESTIGATE_TOOLS: Tool[] = [
  { type: "web_search_preview" },
  {
    type: "function",
    name: "explore_website",
    description: "Fetch and read the full text content of a specific webpage or URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to fetch and read." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "analyze_image",
    description: "Analyze an image from a URL and describe its contents in detail.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct URL to the image." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ── Tool-loop execution (for Investigate) ─────────────────────────────────────

async function callModelWithTools(params: CallModelParams): Promise<string> {
  const meta = params.meta ?? {};
  const model = meta.model ?? process.env.OPENAI_SEARCH_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
  const client = getClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let input: any[] = [{ role: "user", content: params.userMessage }];

  const MAX_ROUNDS = 20;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.responses.create({
      model,
      instructions: params.systemPrompt,
      input,
      tools: INVESTIGATE_TOOLS,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const functionCalls = (response.output as any[]).filter((item: any) => item.type === "function_call");

    if (functionCalls.length === 0) {
      return response.output_text;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = [];
    for (const call of functionCalls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = JSON.parse(call.arguments) as any;
      let output: string;

      switch (call.name) {
        case "explore_website":
          output = await exploreWebsite(args.url as string);
          break;
        case "analyze_image":
          output = await analyzeImage(args.url as string);
          break;
        default:
          output = `[Unknown tool: ${call.name as string}]`;
      }

      toolResults.push({ type: "function_call_output", call_id: call.call_id, output });
    }

    input = [...input, ...response.output, ...toolResults];
  }

  return "[Investigate: max tool rounds reached]";
}

// ── File tools (for Create node) ──────────────────────────────────────────────

type FileMap = Map<string, string>;

const FILE_TOOLS: Tool[] = [
  {
    type: "function",
    name: "create_file",
    description: "Create or overwrite a file with complete content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. src/index.html" },
        content: { type: "string", description: "Complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "edit_file",
    description: "Replace an exact string in a file you already created. old_string must match exactly.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to find and replace." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "append_file",
    description: "Append content to the end of a file you already created.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_file",
    description: "Read the current content of a file you have already created.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "list_files",
    description: "List all files created so far in this session.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
];

function serializeFileMap(fileMap: FileMap): string {
  return Array.from(fileMap.entries())
    .map(([p, content]) => `--- FILE: ${p} ---\n${content}`)
    .join("\n\n");
}

async function callModelWithFileTools(params: CallModelParams): Promise<string> {
  const meta = params.meta ?? {};
  const model = meta.model ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
  const client = getClient();
  const fileMap: FileMap = new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let input: any[] = [{ role: "user", content: params.userMessage }];
  const MAX_ROUNDS = 40;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.responses.create({
      model,
      instructions: params.systemPrompt,
      input,
      tools: FILE_TOOLS,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const functionCalls = (response.output as any[]).filter((item: any) => item.type === "function_call");

    if (functionCalls.length === 0) {
      return fileMap.size > 0 ? serializeFileMap(fileMap) : response.output_text;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = [];
    for (const call of functionCalls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = JSON.parse(call.arguments) as any;
      let output: string;

      switch (call.name as string) {
        case "create_file": {
          fileMap.set(args.path as string, args.content as string);
          output = `Created ${args.path as string} (${(args.content as string).length} chars)`;
          params.onProgress?.(`create_file: ${args.path as string}`);
          break;
        }
        case "edit_file": {
          const existing = fileMap.get(args.path as string);
          if (existing === undefined) {
            output = `Error: "${args.path as string}" not found — call create_file first.`;
          } else if (!existing.includes(args.old_string as string)) {
            output = `Error: old_string not found in "${args.path as string}". Check the exact text.`;
          } else {
            fileMap.set(args.path as string, existing.replace(args.old_string as string, args.new_string as string));
            output = `Edited ${args.path as string}`;
            params.onProgress?.(`edit_file: ${args.path as string}`);
          }
          break;
        }
        case "append_file": {
          const existing = fileMap.get(args.path as string);
          if (existing === undefined) {
            output = `Error: "${args.path as string}" not found — call create_file first.`;
          } else {
            fileMap.set(args.path as string, existing + (args.content as string));
            output = `Appended to ${args.path as string}`;
            params.onProgress?.(`append_file: ${args.path as string}`);
          }
          break;
        }
        case "read_file": {
          output = fileMap.get(args.path as string) ?? `Error: "${args.path as string}" not found.`;
          break;
        }
        case "list_files": {
          output = fileMap.size === 0 ? "No files created yet." : Array.from(fileMap.keys()).join("\n");
          break;
        }
        default:
          output = `[Unknown tool: ${call.name as string}]`;
      }

      toolResults.push({ type: "function_call_output", call_id: call.call_id, output });
    }

    input = [...input, ...response.output, ...toolResults];
  }

  return fileMap.size > 0 ? serializeFileMap(fileMap) : "[Create: max tool rounds reached without output]";
}

// Legacy exports so existing engine.ts callsites continue to compile
export const callOpenAI = (params: CallModelParams) => callModelPlain(params);
export const callOpenAIWithTools = (params: CallModelParams) => callModelWithTools(params);
export { callModelWithTools as callOpenAIWithWebSearch };
