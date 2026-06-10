import OpenAI from "openai";
import type { Tool } from "openai/resources/responses/responses.js";
import { resolveContent } from "./fetchUtils.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set in environment");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export interface CallOpenAIParams {
  systemPrompt: string;
  userMessage: string;
}

export async function callOpenAI(params: CallOpenAIParams): Promise<string> {
  const model = process.env.OPENAI_MODEL ?? "gpt-5.5-mini";
  const client = getClient();

  const response = await client.chat.completions.create({
    model,
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
    // Quick check that the URL is reachable and looks like an image
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const ct = head?.headers.get("content-type") ?? "";
    if (head && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
      // Not a direct image — try fetching as webpage and describe text content
      return await resolveContent(url);
    }

    const client = getClient();
    const model = process.env.OPENAI_MODEL ?? "gpt-5.5-mini";

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
    description: "Fetch and read the full text content of a specific webpage or URL. Use this when you have an exact URL to examine.",
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
    description: "Analyze an image from a URL and describe its contents in detail — objects, text, colors, layout. Use this when given a direct image URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct URL to the image (jpg, png, gif, webp, svg, etc.)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ── Investigate: full tool-loop execution ─────────────────────────────────────

// Uses the Responses API with web_search_preview.
// OPENAI_SEARCH_MODEL controls the model used here; defaults to gpt-4o-search-preview
// which is specifically designed to always search rather than relying on model discretion.
export async function callOpenAIWithTools(params: CallOpenAIParams): Promise<string> {
  const model = process.env.OPENAI_SEARCH_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
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

    // Built-in tools (web_search, code_interpreter) are handled automatically by OpenAI.
    // We only need to handle custom function_call items.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const functionCalls = (response.output as any[]).filter((item: any) => item.type === "function_call");

    if (functionCalls.length === 0) {
      return response.output_text;
    }

    // Execute each function call and collect results
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

    // Append model output + tool results for next round
    input = [...input, ...response.output, ...toolResults];
  }

  // Shouldn't normally reach here — return whatever text we have from last response
  return "[Investigate: max tool rounds reached]";
}

// Keep alias so engine.ts import doesn't break during transition
export { callOpenAIWithTools as callOpenAIWithWebSearch };
