import path from "node:path";
import type {
  ArtifactRecord,
  EvaluationVerdict,
  LedgerFact,
  LedgerSource,
  RepairRecord,
  RunLedger,
} from "../../../shared/types.js";
import { createId } from "../../utils/id.js";

export function createRunLedger(id: string, taskGoal: string): RunLedger {
  return {
    id,
    taskGoal,
    startedAt: Date.now(),
    sources: [],
    facts: [],
    nodeOutputs: [],
    artifacts: [],
    evaluations: [],
    repairs: [],
  };
}

export function completeRunLedger(ledger: RunLedger): void {
  ledger.completedAt = Date.now();
}

export function addLedgerSource(
  ledger: RunLedger,
  source: Omit<LedgerSource, "id">
): LedgerSource {
  const existing = ledger.sources.find((item) =>
    item.nodeId === source.nodeId &&
    item.kind === source.kind &&
    item.label === source.label &&
    item.url === source.url
  );
  if (existing) return existing;

  const next: LedgerSource = { id: createId("source"), ...source };
  ledger.sources.push(next);
  return next;
}

export function addLedgerFact(
  ledger: RunLedger,
  fact: Omit<LedgerFact, "id" | "createdAt">
): LedgerFact {
  const next: LedgerFact = {
    id: createId("fact"),
    createdAt: Date.now(),
    ...fact,
  };
  ledger.facts.push(next);
  return next;
}

export function recordNodeOutput(
  ledger: RunLedger,
  output: { nodeId: string; role?: string; label: string; output: string }
): void {
  ledger.nodeOutputs.push({ ...output, createdAt: Date.now() });
}

export function recordArtifact(
  ledger: RunLedger,
  artifact: Omit<ArtifactRecord, "id" | "createdAt">
): ArtifactRecord {
  const next: ArtifactRecord = {
    id: createId("artifact"),
    createdAt: Date.now(),
    ...artifact,
  };
  ledger.artifacts.push(next);
  return next;
}

export function recordEvaluation(
  ledger: RunLedger,
  evaluation: Omit<EvaluationVerdict, "id" | "createdAt">
): EvaluationVerdict {
  const next: EvaluationVerdict = {
    id: createId("eval"),
    createdAt: Date.now(),
    ...evaluation,
  };
  ledger.evaluations.push(next);
  return next;
}

export function recordRepair(
  ledger: RunLedger,
  repair: Omit<RepairRecord, "id" | "createdAt">
): RepairRecord {
  const next: RepairRecord = {
    id: createId("repair"),
    createdAt: Date.now(),
    ...repair,
  };
  ledger.repairs.push(next);
  return next;
}

function preview(text: string, max = 900): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

export function buildLedgerSummary(ledger: RunLedger, maxChars = 7000): string {
  const sections: string[] = [];

  if (ledger.sources.length > 0) {
    sections.push([
      "Sources:",
      ...ledger.sources.slice(-10).map((source) =>
        `- ${source.label}${source.url ? ` (${source.url})` : ""}`
      ),
    ].join("\n"));
  }

  if (ledger.facts.length > 0) {
    sections.push([
      "Known facts:",
      ...ledger.facts.slice(-24).map((fact) =>
        `- ${fact.title}: ${preview(fact.content, 420)}`
      ),
    ].join("\n"));
  }

  if (ledger.nodeOutputs.length > 0) {
    sections.push([
      "Prior node outputs:",
      ...ledger.nodeOutputs.slice(-8).map((item) =>
        `- ${item.label}${item.role ? ` [${item.role}]` : ""}: ${preview(item.output, 520)}`
      ),
    ].join("\n"));
  }

  if (ledger.evaluations.length > 0) {
    sections.push([
      "Evaluation verdicts:",
      ...ledger.evaluations.slice(-8).map((item) =>
        `- ${item.verdict.toUpperCase()}: ${item.issues.join("; ") || "No issues recorded."}`
      ),
    ].join("\n"));
  }

  const summary = sections.join("\n\n");
  return summary.length > maxChars ? `${summary.slice(0, maxChars)}\n[… ledger truncated]` : summary;
}

export function stripSingleMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  if (!match) return content;
  return `${match[1].trimEnd()}\n`;
}

export function rawArtifactPathNeedsFenceStripping(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return new Set([
    ".html",
    ".htm",
    ".css",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".xml",
    ".svg",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".cs",
    ".php",
  ]).has(ext);
}

export function stripMarkdownFenceForPath(filePath: string, content: string): string {
  return rawArtifactPathNeedsFenceStripping(filePath) ? stripSingleMarkdownFence(content) : content;
}

export function hasGenericPlaceholders(content: string): boolean {
  return /\b(Project One|Project Two|Project Three|Lorem ipsum|TODO\b|TBD\b|example\.com|your company|your brand|placeholder)\b/i.test(content);
}

export function artifactQualityIssues(content: string, hasSourceEvidence: boolean): string[] {
  const issues: string[] = [];
  if (!content.trim()) issues.push("Artifact is empty.");
  if (stripSingleMarkdownFence(content) !== content) {
    issues.push("Artifact is wrapped in a markdown code fence.");
  }
  if (hasSourceEvidence && hasGenericPlaceholders(content)) {
    issues.push("Artifact contains generic placeholder content despite available source evidence.");
  }
  return issues;
}
