import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";
import type { EdgeV2, NodeV2 } from "../../../shared/types.js";
import { edges, nodes } from "../state/store.js";
import { updateNode } from "../state/operations.js";
import { callOpenAI, callOpenAIWithWebSearch } from "./provider.js";
import { loadSkill } from "./skillLoader.js";

export interface RunContext {
  workspacePath: string;
  onNodeStatus: (nodeId: string, status: NodeV2["status"], output: string | null) => void;
  abortSignal: AbortSignal;
}

interface ChainError extends Error {
  nodeId?: string;
}

function findInitialiser(): NodeV2 | null {
  for (const node of nodes.values()) {
    if (node.type === "initialiser") return node;
  }
  return null;
}

function edgesFrom(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.sourceId === nodeId && e.kind === kind);
}

function edgesTo(nodeId: string, kind: EdgeV2["kind"]): EdgeV2[] {
  return Array.from(edges.values()).filter((e) => e.targetId === nodeId && e.kind === kind);
}

function buildChain(startId: string): NodeV2[] {
  const chain: NodeV2[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const node = nodes.get(currentId);
    if (!node) break;
    chain.push(node);
    const outEdges = edgesFrom(currentId, "flow");
    currentId = outEdges[0]?.targetId ?? null;
  }

  return chain;
}

function isUrl(text: string): boolean {
  try { return ["http:", "https:"].includes(new URL(text).protocol); } catch { return false; }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function resolveContent(raw: string): Promise<string> {
  const url = raw.trim();
  if (!isUrl(url)) return raw;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "DISPATCH.AI/1.0 (context fetcher)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `[Failed to fetch ${url}: HTTP ${res.status}]`;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const body = ct.includes("html") ? stripHtml(text) : text;
    return `[Fetched: ${url}]\n${body.slice(0, 12_000)}`;
  } catch (err) {
    return `[Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function gatherMidputContent(nodeId: string): Promise<string> {
  const midputEdges = edgesTo(nodeId, "midput");
  const parts: string[] = [];
  for (const edge of midputEdges) {
    const source = nodes.get(edge.sourceId);
    if (!source) continue;
    const raw = source.config?.content?.trim() ?? source.output?.trim() ?? "";
    if (!raw) continue;
    const resolved = await resolveContent(raw);
    parts.push(resolved);
  }
  return parts.join("\n\n---\n\n");
}

function buildUserMessage(flowInput: string, midputContent: string, taskPrompt: string): string {
  const sections: string[] = [];
  if (midputContent) {
    sections.push(`[Context]\n${midputContent}`);
  }
  if (flowInput) {
    sections.push(`[Chain Input]\n${flowInput}`);
  }
  if (taskPrompt) {
    sections.push(`[Task At Hand]\n${taskPrompt}`);
  }
  return sections.join("\n\n");
}

function parseFileMap(input: string): Map<string, string> {
  const files = new Map<string, string>();
  const delimiter = /^---\s*FILE:\s*(.+?)\s*---\s*$/m;
  const parts = input.split(/^---\s*FILE:\s*.+?\s*---\s*$/m);
  const headers = [...input.matchAll(/^---\s*FILE:\s*(.+?)\s*---\s*$/gm)];

  for (let i = 0; i < headers.length; i++) {
    const filePath = headers[i][1].trim();
    const content = (parts[i + 1] ?? "").trimStart();
    if (filePath) files.set(filePath, content);
  }

  void delimiter; // referenced for clarity
  return files;
}

function materialize(input: string, workspacePath: string): string {
  const files = parseFileMap(input);
  if (files.size === 0) {
    throw new Error(
      `Materialize: no file delimiters found in Create output.\nPreview: ${input.slice(0, 300)}`
    );
  }

  const summary: string[] = [];
  for (const [relPath, content] of files) {
    const absPath = path.resolve(workspacePath, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    summary.push(`${relPath} (${Buffer.byteLength(content, "utf-8")} bytes)`);
  }

  return `Materialized ${files.size} file(s):\n${summary.join("\n")}`;
}

export async function runChain(ctx: RunContext): Promise<void> {
  const initialiser = findInitialiser();
  if (!initialiser) throw new Error("No Initialiser node on canvas");

  const flowStarts = edgesFrom(initialiser.id, "flow");
  if (flowStarts.length === 0) throw new Error("Initialiser has no connected flow output");

  const firstNodeId = flowStarts[0].targetId;
  const chain = buildChain(firstNodeId);
  if (chain.length === 0) throw new Error("Chain is empty");

  // Reset all chain nodes to idle before starting
  for (const node of chain) {
    updateNode(node.id, { status: "idle", output: null });
    ctx.onNodeStatus(node.id, "idle", null);
  }

  let flowInput = "";

  for (const node of chain) {
    if (ctx.abortSignal.aborted) break;

    ctx.onNodeStatus(node.id, "running", null);
    updateNode(node.id, { status: "running", output: null });

    try {
      let output: string;

      if (node.type === "materialize") {
        output = materialize(flowInput, ctx.workspacePath);
      } else if (SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number])) {
        const skill = loadSkill(node.type);
        const midputContent = await gatherMidputContent(node.id);
        const taskPrompt = node.config?.taskPrompt ?? "";
        const userMessage = buildUserMessage(flowInput, midputContent, taskPrompt);

        if (!userMessage.trim()) {
          throw new Error(`Node "${node.title}" has no task prompt or input`);
        }

        output = await (node.type === "investigate"
          ? callOpenAIWithWebSearch({ systemPrompt: skill, userMessage })
          : callOpenAI({ systemPrompt: skill, userMessage }));
      } else {
        output = flowInput;
      }

      updateNode(node.id, { status: "done", output });
      ctx.onNodeStatus(node.id, "done", output);
      flowInput = output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateNode(node.id, { status: "error", output: message });
      ctx.onNodeStatus(node.id, "error", message);
      const chainErr = new Error(message) as ChainError;
      chainErr.nodeId = node.id;
      throw chainErr;
    }
  }
}
