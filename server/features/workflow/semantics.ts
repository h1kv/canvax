import type { EdgeKind } from "../../../shared/types.js";

export interface CanvasOp {
  op: string;
  tmpId?: string;
  typeId?: string;
  label?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  nodeId?: string;
  patch?: { label?: string; config?: Record<string, unknown> };
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
  sourcePort?: string;
  edgeKind?: EdgeKind;
}

export interface WorkflowNodeSnapshot {
  id: string;
  typeId: string;
  label?: string;
  x: number;
  y: number;
  config?: Record<string, unknown>;
}

export interface WorkflowEdgeSnapshot {
  id: string;
  sourceId: string;
  targetId: string;
  sourcePort?: string;
  edgeKind?: EdgeKind;
}

export interface WorkflowSnapshot {
  nodes: WorkflowNodeSnapshot[];
  edges: WorkflowEdgeSnapshot[];
}

export interface WorkflowTemplateResult {
  response: string;
  operations: CanvasOp[];
}

export interface NormalizedCanvasOps {
  operations: CanvasOp[];
  warnings: string[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;

function normalizeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractFirstUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  return match ? normalizeUrl(match[0]) : null;
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "URL context";
  }
}

function isBareUrlRequest(text: string, url: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && normalizeUrl(trimmed) === url;
}

function lowerWords(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isBuildWebsiteRequest(text: string, hasUrlReference: boolean): boolean {
  const lower = lowerWords(text);
  const buildVerb = /\b(make|build|create|generate|redesign|improve|better|upgrade|revamp)\b/.test(lower);
  const siteNoun = /\b(web\s*site|website|site|page|landing page|homepage)\b/.test(lower);
  const fromContext = hasUrlReference || /\b(that|this|url|website|site|context|source)\b/.test(lower);
  return buildVerb && siteNoun && fromContext;
}

function isAnalyzeSiteRequest(text: string, hasUrlReference: boolean): boolean {
  const lower = lowerWords(text);
  const analyzeVerb = /\b(analy[sz]e|evaluate|audit|review|investigate|assess)\b/.test(lower);
  const siteNoun = /\b(web\s*site|website|site|page|url)\b/.test(lower);
  const fromContext = hasUrlReference || /\b(that|this|url|website|site|context|source)\b/.test(lower);
  return analyzeVerb && siteNoun && fromContext;
}

function isResearchThenWriteRequest(text: string): boolean {
  const lower = lowerWords(text);
  return /\b(research|investigate)\b/.test(lower) && /\b(write|draft|create|produce)\b/.test(lower);
}

function nodeType(snapshot: WorkflowSnapshot, id: string): string | null {
  return snapshot.nodes.find((node) => node.id === id)?.typeId ?? null;
}

function findStartNode(snapshot: WorkflowSnapshot): WorkflowNodeSnapshot | null {
  return snapshot.nodes.find((node) => node.typeId === "start") ?? null;
}

function findUrlContextNode(snapshot: WorkflowSnapshot, url?: string | null): WorkflowNodeSnapshot | null {
  const contexts = snapshot.nodes.filter((node) =>
    node.typeId === "context" &&
    node.config?.sourceType === "url" &&
    typeof node.config.url === "string" &&
    node.config.url.trim()
  );
  if (url) {
    return contexts.find((node) => normalizeUrl(String(node.config?.url ?? "")) === url) ?? null;
  }
  return contexts.sort((a, b) => b.y - a.y || b.x - a.x)[0] ?? null;
}

function startReference(snapshot: WorkflowSnapshot, operations: CanvasOp[], taskDescription: string): string {
  const existingStart = findStartNode(snapshot);
  if (existingStart) {
    operations.push({
      op: "update_node",
      nodeId: existingStart.id,
      patch: {
        config: {
          taskDescription,
          defaultModel: "gpt-4o",
          defaultProvider: "openai",
        },
      },
    });
    return existingStart.id;
  }

  operations.push({
    op: "create_node",
    tmpId: "tmp_start",
    typeId: "start",
    label: "Start",
    position: { x: 200, y: 160 },
    config: {
      taskDescription,
      defaultModel: "gpt-4o",
      defaultProvider: "openai",
    },
  });
  return "tmp_start";
}

function contextReference(
  snapshot: WorkflowSnapshot,
  operations: CanvasOp[],
  url: string,
  x = 520,
  y = 160
): string {
  const existing = findUrlContextNode(snapshot, url);
  if (existing) {
    operations.push({
      op: "update_node",
      nodeId: existing.id,
      patch: {
        label: `Context: ${domainLabel(url)}`,
        config: {
          sourceType: "url",
          url,
          notes: `Source website context from ${url}`,
          spreadToChain: false,
        },
      },
    });
    return existing.id;
  }

  operations.push({
    op: "create_node",
    tmpId: "tmp_context_url",
    typeId: "context",
    label: `Context: ${domainLabel(url)}`,
    position: { x, y },
    config: {
      sourceType: "url",
      url,
      notes: `Source website context from ${url}`,
      spreadToChain: false,
    },
  });
  return "tmp_context_url";
}

function agent(
  tmpId: string,
  label: string,
  role: string,
  taskPrompt: string,
  position: { x: number; y: number },
  config: Record<string, unknown> = {}
): CanvasOp {
  return {
    op: "create_node",
    tmpId,
    typeId: "agent",
    label,
    position,
    config: {
      role,
      taskPrompt,
      model: "gpt-4o",
      provider: "openai",
      tools: role === "investigate" ? ["web_search", "fetch_url"] : [],
      maxToolCalls: role === "investigate" ? 6 : 0,
      ...config,
    },
  };
}

function flow(sourceId: string, targetId: string, sourcePort = "default"): CanvasOp {
  return { op: "create_edge", sourceId, targetId, sourcePort, edgeKind: "flow" };
}

function contextEdge(sourceId: string, targetId: string): CanvasOp {
  return { op: "create_edge", sourceId, targetId, sourcePort: "default", edgeKind: "context" };
}

export function repairInvalidExistingEdgeOps(snapshot: WorkflowSnapshot): CanvasOp[] {
  const operations: CanvasOp[] = [];

  for (const edge of snapshot.edges) {
    const sourceType = nodeType(snapshot, edge.sourceId);
    const targetType = nodeType(snapshot, edge.targetId);
    if (!sourceType || !targetType) continue;

    if (targetType === "context") {
      operations.push({ op: "delete_edge", edgeId: edge.id });
      continue;
    }

    if (sourceType === "context" && edge.edgeKind !== "context") {
      operations.push({ op: "delete_edge", edgeId: edge.id });
      operations.push(contextEdge(edge.sourceId, edge.targetId));
    }
  }

  return operations;
}

function buildWebsiteTemplate(snapshot: WorkflowSnapshot, url: string): WorkflowTemplateResult {
  const operations = repairInvalidExistingEdgeOps(snapshot);
  const startRef = startReference(
    snapshot,
    operations,
    `Create a better website from ${url}. Preserve concrete facts from the source site and do not use generic placeholders.`
  );
  const contextRef = contextReference(snapshot, operations, url, 200, 296);

  operations.push(
    agent(
      "tmp_investigate_site",
      "Investigate current site",
      "investigate",
      "Fetch and analyze the source website. Extract brand, services, audience, page structure, proof points, tone, and concrete content that must carry into the improved site.",
      { x: 200, y: 448 },
      { tools: ["fetch_url", "web_search"], maxToolCalls: 6 }
    ),
    agent(
      "tmp_plan_site",
      "Plan site improvements",
      "plan",
      "Turn the investigation into a concise build plan for the improved website. Include target audience, content sections, conversion goals, and acceptance criteria.",
      { x: 200, y: 608 }
    ),
    agent(
      "tmp_design_site",
      "Design improved page",
      "design",
      "Design the page structure, visual direction, responsive layout, copy hierarchy, and interaction details for the improved website.",
      { x: 200, y: 768 }
    ),
    agent(
      "tmp_create_site",
      "Create improved site",
      "create",
      "Create a complete, single-file HTML website using the investigation, plan, design, and URL context. Output raw HTML only. Do not wrap it in markdown fences. Do not include placeholder projects or invented filler.",
      { x: 200, y: 928 },
      { outputMode: "raw-artifact", autoRepair: true, maxRepairRounds: 2 }
    ),
    agent(
      "tmp_evaluate_site",
      "Evaluate site quality",
      "evaluate",
      "Evaluate the created website against the source evidence and quality gates. Fail placeholder content and repairable generic output.",
      { x: 200, y: 1088 },
      { passThroughArtifact: true, autoRepair: true, maxRepairRounds: 2 }
    ),
    {
      op: "create_node",
      tmpId: "tmp_write_site",
      typeId: "file-write",
      label: "File Write",
      position: { x: 200, y: 1248 },
      config: { path: "output/improved-site.html", mode: "write" },
    },
    flow(startRef, "tmp_investigate_site"),
    flow("tmp_investigate_site", "tmp_plan_site"),
    flow("tmp_plan_site", "tmp_design_site"),
    flow("tmp_design_site", "tmp_create_site"),
    flow("tmp_create_site", "tmp_evaluate_site"),
    flow("tmp_evaluate_site", "tmp_write_site"),
    contextEdge(contextRef, "tmp_investigate_site"),
    contextEdge(contextRef, "tmp_plan_site"),
    contextEdge(contextRef, "tmp_design_site"),
    contextEdge(contextRef, "tmp_create_site"),
    contextEdge(contextRef, "tmp_evaluate_site")
  );

  return {
    response: `Built a real website-creation chain from ${domainLabel(url)}: investigate, plan, design, create, evaluate, then write the HTML file. The URL context is attached as context input to every downstream agent.`,
    operations,
  };
}

function analyzeSiteTemplate(snapshot: WorkflowSnapshot, url: string): WorkflowTemplateResult {
  const operations = repairInvalidExistingEdgeOps(snapshot);
  const startRef = startReference(snapshot, operations, `Analyze and evaluate the website at ${url}.`);
  const contextRef = contextReference(snapshot, operations, url, 200, 296);

  operations.push(
    agent(
      "tmp_evaluate_site",
      "Investigate current site",
      "investigate",
      "Fetch and evaluate the current website. Identify strengths, weaknesses, content gaps, conversion issues, and concrete opportunities backed by source evidence.",
      { x: 200, y: 448 },
      { tools: ["fetch_url", "web_search"], maxToolCalls: 6 }
    ),
    flow(startRef, "tmp_evaluate_site"),
    contextEdge(contextRef, "tmp_evaluate_site")
  );

  return {
    response: `Added an executable site investigation chain with ${domainLabel(url)} attached as URL context.`,
    operations,
  };
}

function researchThenWriteTemplate(snapshot: WorkflowSnapshot, request: string): WorkflowTemplateResult {
  const operations = repairInvalidExistingEdgeOps(snapshot);
  const startRef = startReference(snapshot, operations, request);

  operations.push(
    agent(
      "tmp_investigate",
      "Investigate",
      "investigate",
      "Research the task thoroughly and extract the facts, sources, constraints, and useful details downstream writers need.",
      { x: 200, y: 320 },
      { tools: ["web_search", "fetch_url"], maxToolCalls: 6 }
    ),
    agent(
      "tmp_create",
      "Create",
      "create",
      "Write the requested output using the investigation. Be concrete and avoid unsupported claims.",
      { x: 200, y: 480 }
    ),
    agent(
      "tmp_evaluate",
      "Evaluate",
      "evaluate",
      "Evaluate the created output against the task and investigation. Identify issues and produce a corrected final version if needed.",
      { x: 200, y: 640 }
    ),
    flow(startRef, "tmp_investigate"),
    flow("tmp_investigate", "tmp_create"),
    flow("tmp_create", "tmp_evaluate")
  );

  return {
    response: "Added an executable research, create, and evaluate chain.",
    operations,
  };
}

function urlContextTemplate(snapshot: WorkflowSnapshot, url: string): WorkflowTemplateResult {
  const operations = repairInvalidExistingEdgeOps(snapshot);
  contextReference(snapshot, operations, url, 520, 160);
  return {
    response: `Added ${domainLabel(url)} as URL context. It will resolve during a run and feed any agent connected with a context edge.`,
    operations,
  };
}

export function templateForRequest(request: string, snapshot: WorkflowSnapshot): WorkflowTemplateResult | null {
  const url = extractFirstUrl(request);
  const existingUrl = findUrlContextNode(snapshot, url)?.config?.url;
  const referencedUrl = url ?? (typeof existingUrl === "string" ? normalizeUrl(existingUrl) : null);
  const hasUrlReference = Boolean(referencedUrl);

  if (url && isBareUrlRequest(request, url)) {
    return urlContextTemplate(snapshot, url);
  }

  if (referencedUrl && isBuildWebsiteRequest(request, hasUrlReference)) {
    return buildWebsiteTemplate(snapshot, referencedUrl);
  }

  if (referencedUrl && isAnalyzeSiteRequest(request, hasUrlReference)) {
    return analyzeSiteTemplate(snapshot, referencedUrl);
  }

  if (isResearchThenWriteRequest(request)) {
    return researchThenWriteTemplate(snapshot, request);
  }

  return null;
}

export function normalizeCanvasOperations(ops: CanvasOp[], snapshot: WorkflowSnapshot): NormalizedCanvasOps {
  const warnings: string[] = [];
  const operations: CanvasOp[] = [];
  const createdTypes = new Map<string, string>();

  for (const op of ops) {
    if (op.op === "create_node" && op.tmpId && op.typeId) {
      createdTypes.set(op.tmpId, op.typeId);
    }
  }

  const typeForRef = (ref: string | undefined): string | null => {
    if (!ref) return null;
    return createdTypes.get(ref) ?? nodeType(snapshot, ref);
  };

  for (const op of ops) {
    if (op.op !== "create_edge") {
      operations.push(op);
      continue;
    }

    const sourceType = typeForRef(op.sourceId);
    const targetType = typeForRef(op.targetId);
    if (!sourceType || !targetType) {
      warnings.push("Dropped edge with unknown source or target.");
      continue;
    }

    if (targetType === "context") {
      warnings.push("Dropped edge into Context node. Context is side-car input, not an executable step.");
      continue;
    }

    if (sourceType === "context") {
      operations.push({ ...op, sourcePort: "default", edgeKind: "context" });
      continue;
    }

    operations.push({ ...op, edgeKind: "flow" });
  }

  return { operations, warnings };
}
