import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";

const execAsync = promisify(exec);

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: "web_search",
    label: "Web Search",
    description: "Search the public web for current or external information.",
    args: { query: "string" },
  },
  {
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch and extract text from an http(s) URL.",
    args: { url: "string" },
  },
  {
    name: "read_file",
    label: "Read File",
    description: "Read a UTF-8 text file from the workspace.",
    args: { path: "string" },
  },
  {
    name: "write_file",
    label: "Write File",
    description: "Write or append UTF-8 text to a file inside the workspace.",
    args: { path: "string", content: "string", mode: "write | append" },
  },
  {
    name: "list_files",
    label: "List Files",
    description: "List files under a workspace directory.",
    args: { path: "string", maxEntries: "number" },
  },
  {
    name: "shell_exec",
    label: "Shell Exec",
    description: "Run a shell command inside the workspace and capture stdout, stderr, and exitCode.",
    args: { command: "string", workdir: "string", timeout: "number" },
  },
] as const;

export type AgentToolName = typeof AGENT_TOOL_DEFINITIONS[number]["name"];

export interface AgentToolSchema {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    };
  };
}

const TOOL_NAMES = new Set<string>(AGENT_TOOL_DEFINITIONS.map((tool) => tool.name));
const DEFAULT_AGENT_TOOLS: AgentToolName[] = ["web_search", "fetch_url"];
const WORKSPACE_ROOT = process.cwd();

function capText(text: string, max = 12000): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated]` : text;
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeWorkspaceRelativePath(rawPath: string): string {
  return rawPath
    .replace(/^[A-Za-z]:[\\/]+/, "")
    .replace(/^[\\/]+/, "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
}

export function resolveWorkspacePath(rawPath: string, fallback = "."): string {
  const trimmed = (rawPath || fallback).trim();
  if (!trimmed) return WORKSPACE_ROOT;

  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(WORKSPACE_ROOT, trimmed);

  if (isInsideDirectory(WORKSPACE_ROOT, candidate)) return candidate;

  const workspaceRelativePath = normalizeWorkspaceRelativePath(trimmed);
  return path.resolve(WORKSPACE_ROOT, workspaceRelativePath || ".");
}

export function normalizeAllowedAgentTools(value: unknown): AgentToolName[] {
  if (!Array.isArray(value)) return DEFAULT_AGENT_TOOLS;
  const allowed = value.filter((name): name is AgentToolName => typeof name === "string" && TOOL_NAMES.has(name));
  return Array.from(new Set(allowed));
}

function schemaForTool(name: AgentToolName): AgentToolSchema["function"]["parameters"] {
  if (name === "web_search") {
    return {
      type: "object",
      properties: { query: { type: "string", description: "Search query." } },
      required: ["query"],
      additionalProperties: false,
    };
  }
  if (name === "fetch_url") {
    return {
      type: "object",
      properties: { url: { type: "string", description: "HTTP or HTTPS URL to fetch." } },
      required: ["url"],
      additionalProperties: false,
    };
  }
  if (name === "read_file") {
    return {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path." } },
      required: ["path"],
      additionalProperties: false,
    };
  }
  if (name === "write_file") {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Text content to write." },
        mode: { type: "string", enum: ["write", "append"], description: "Write mode." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    };
  }
  if (name === "list_files") {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path." },
        maxEntries: { type: "number", description: "Maximum entries to return." },
      },
      required: [],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      workdir: { type: "string", description: "Workspace-relative working directory." },
      timeout: { type: "number", description: "Timeout in milliseconds." },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

export function getAgentToolSchemas(allowedTools: AgentToolName[]): AgentToolSchema[] {
  return AGENT_TOOL_DEFINITIONS
    .filter((tool) => allowedTools.includes(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schemaForTool(tool.name),
      },
    }));
}

export function buildAgentToolInstructions(allowedTools: AgentToolName[]): string {
  if (allowedTools.length === 0) {
    return "No live tools are enabled for this node. Use only the provided input and context.";
  }

  const tools = AGENT_TOOL_DEFINITIONS
    .filter((tool) => allowedTools.includes(tool.name))
    .map((tool) => `- ${tool.name}: ${tool.description} Args: ${JSON.stringify(tool.args)}`)
    .join("\n");

  return `You may use live tools while completing this node.

Allowed tools:
${tools}

Tool protocol:
- To call a tool, respond with ONLY JSON: {"toolCall":{"name":"web_search","args":{"query":"..."}}}
- Use one tool call at a time. Wait for the tool result before deciding the next step.
- If the task asks you to research, investigate, verify, or use public/current information, call web_search or fetch_url before giving a final answer when those tools are enabled.
- When you are done, respond with the final answer directly, or as JSON: {"final":"..."}
- Do not invent tool results. If a tool fails, adapt from the error message.`;
}

export async function webSearch(query: string): Promise<string> {
  const safeQuery = query.trim();
  if (!safeQuery) return "Search query was empty.";

  const apiKey = process.env.BRAVE_API_KEY;
  if (apiKey) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(safeQuery)}&count=5&text_decorations=false`;
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    const json = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
    const results = json.web?.results ?? [];
    return results.map((r, i) =>
      `[${i + 1}] ${r.title}\n${r.url}\n${r.description}`
    ).join("\n\n") || "No results found.";
  }

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(safeQuery)}&format=json&no_redirect=1&no_html=1`;
  const res = await fetch(url, { headers: { "User-Agent": "dispatch-ai/1.0" } });
  const json = await res.json() as { AbstractText?: string; RelatedTopics?: Array<{ Text?: string; FirstURL?: string }> };
  const parts: string[] = [];
  if (json.AbstractText) parts.push(json.AbstractText);
  const related = (json.RelatedTopics ?? []).slice(0, 5);
  for (const item of related) {
    if (item.Text) parts.push(`- ${item.Text}${item.FirstURL ? ` (${item.FirstURL})` : ""}`);
  }
  return parts.join("\n\n") || `No instant answers found for: ${safeQuery}`;
}

async function fetchUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("fetch_url only supports http(s) URLs");
  }
  const res = await fetch(parsed.toString(), { headers: { "User-Agent": "dispatch-ai/1.0" } });
  const contentType = res.headers.get("content-type") ?? "";
  const rawText = await res.text();
  const text = contentType.includes("html") ? stripHtml(rawText) : rawText;
  return capText(`Status: ${res.status} ${res.statusText}\nURL: ${parsed.toString()}\n\n${text}`);
}

async function listFiles(rawPath: string, maxEntries: number): Promise<string> {
  const root = resolveWorkspacePath(rawPath || ".");
  const limit = Math.max(1, Math.min(Number(maxEntries) || 120, 300));
  const ignored = new Set([".git", "node_modules", "dist"]);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(WORKSPACE_ROOT, fullPath) || ".";
      results.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (entry.isDirectory()) await walk(fullPath);
    }
  }

  await walk(root);
  return results.join("\n") || "No files found.";
}

function getStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

export async function executeAgentTool(name: AgentToolName, rawArgs: unknown): Promise<string> {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};

  if (name === "web_search") {
    return webSearch(getStringArg(args, "query"));
  }

  if (name === "fetch_url") {
    return fetchUrl(getStringArg(args, "url"));
  }

  if (name === "read_file") {
    const filePath = resolveWorkspacePath(getStringArg(args, "path"));
    const text = await readFile(filePath, "utf-8");
    return capText(`Path: ${path.relative(WORKSPACE_ROOT, filePath)}\n\n${text}`, 16000);
  }

  if (name === "write_file") {
    const filePath = resolveWorkspacePath(getStringArg(args, "path"));
    const content = getStringArg(args, "content");
    const mode = getStringArg(args, "mode") === "append" ? "append" : "write";
    await mkdir(path.dirname(filePath), { recursive: true });
    if (mode === "append") {
      await appendFile(filePath, content, "utf-8");
    } else {
      await writeFile(filePath, content, "utf-8");
    }
    return `Wrote ${content.length} chars to ${path.relative(WORKSPACE_ROOT, filePath)}.`;
  }

  if (name === "list_files") {
    return listFiles(getStringArg(args, "path"), Number(args.maxEntries));
  }

  if (name === "shell_exec") {
    const command = getStringArg(args, "command");
    if (!command) throw new Error("shell_exec requires a command");
    const workdir = resolveWorkspacePath(getStringArg(args, "workdir") || ".");
    const timeout = Math.max(1000, Math.min(Number(args.timeout) || 30000, 120000));
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
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
    return capText(JSON.stringify({
      cwd: path.relative(WORKSPACE_ROOT, workdir) || ".",
      stdout,
      stderr,
      exitCode,
    }, null, 2), 16000);
  }

  throw new Error(`Unknown tool: ${name}`);
}
