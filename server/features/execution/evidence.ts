import { createHash, randomUUID } from "node:crypto";
import type { EvidenceFact, EvidenceSourceType, NodeV2, RunLedger } from "../../../shared/types.js";

const MAX_FACTS = 20;
const MAX_SUMMARY_CHARS = 900;

const PROFESSIONAL_HINTS = [
  "name",
  "developer",
  "designer",
  "engineer",
  "student",
  "freelancer",
  "founder",
  "creator",
  "portfolio",
  "project",
  "skill",
  "experience",
  "award",
  "contact",
  "email",
  "github",
  "linkedin",
  "website",
  "react",
  "typescript",
];

const SPECULATIVE_PERSONAL_PATTERNS = [
  /\bdeveloper,\s*designer,\s*and\s*innovator\b/i,
  /\btask manager app\b/i,
  /\bdesign system library\b/i,
  /\bdeveloper of the year\b/i,
  /\binnovation excellence\b/i,
  /\badam\.bell@example\.com\b/i,
  /\+353\s*12\s*345\s*678/i,
  /github\.com\/adambell/i,
  /taskman\.adambell\.com/i,
  /designsystem\.adambell\.com/i,
  /via\.placeholder\.com/i,
  /unsplash\.com/i,
  /portrait photo of adam bell/i,
];

function compact(text: string, limit = MAX_SUMMARY_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function splitCandidateFacts(text: string): string[] {
  const urlFree = text.replace(/https?:\/\/\S+/g, "");
  return text
    .split(/\n+|[.;]\s+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line.length >= 8 && line.length <= 220)
    .filter((line) => !/^https?:\/\//i.test(line))
    .filter((line) => PROFESSIONAL_HINTS.some((hint) => line.toLowerCase().includes(hint)) || /@|\bgithub\.com\b|\blinkedin\.com\b/i.test(line))
    .filter(() => urlFree.trim().length > 0)
    .slice(0, MAX_FACTS);
}

export function createRunLedger(goal: string): RunLedger {
  return {
    runId: `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    goal: compact(goal, 300),
    facts: [],
    gaps: [],
    nodeOutputs: [],
    artifactSummaries: [],
    evaluationIssues: [],
  };
}

export function cloneLedger(ledger: RunLedger): RunLedger {
  return {
    ...ledger,
    facts: [...ledger.facts],
    gaps: [...ledger.gaps],
    nodeOutputs: [...ledger.nodeOutputs],
    artifactSummaries: [...ledger.artifactSummaries],
    evaluationIssues: [...ledger.evaluationIssues],
  };
}

export function addUserFacts(
  ledger: RunLedger,
  text: string,
  sourceRef: string,
  createdByNodeId?: string | null,
  sourceType: EvidenceSourceType = "user"
): void {
  const facts = splitCandidateFacts(text);
  for (const claim of facts) {
    if (ledger.facts.some((fact) => fact.claim.toLowerCase() === claim.toLowerCase())) continue;
    const fact: EvidenceFact = {
      id: `fact_${hash(`${sourceRef}:${claim}`)}`,
      claim,
      sourceType,
      sourceRef,
      confidence: "high",
      verified: sourceType !== "investigate",
      createdByNodeId: createdByNodeId ?? null,
    };
    ledger.facts.push(fact);
  }
}

export function addNodeOutputSummary(ledger: RunLedger, node: NodeV2, output: string): void {
  ledger.nodeOutputs.push({
    nodeId: node.id,
    nodeType: node.type,
    title: node.title,
    summary: compact(output),
  });
  if (node.type === "investigate") {
    addUserFacts(ledger, output, `node:${node.id}`, node.id, "investigate");
  }
  if (node.type === "materialize") {
    ledger.artifactSummaries.push(compact(output, 400));
  }
}

export function addEvaluationIssue(ledger: RunLedger, issue: string): void {
  ledger.evaluationIssues.push(compact(issue, 500));
}

export function hasPersonalPortfolioIntent(text: string): boolean {
  if (/\b(fictional|imaginary|made[- ]?up|invented|sample persona|demo persona)\b/i.test(text)) return false;
  if (/\b(gallery|agency|studio|company|business|venue|restaurant|festival|school|club|organisation|organization|brand)\b/i.test(text)
    && !/\b(my portfolio|my name|i am|i'm|about me)\b/i.test(text)) return false;
  return /\bportfolio\b/i.test(text)
    && /\b(name is|i am|i'm|for\s+[A-Z][a-z]+|about\s+[A-Z][a-z]+)\b/i.test(text);
}

export function hasEnoughVerifiedPersonalFacts(ledger: RunLedger): boolean {
  // If an Investigate node has already run, its output is the research record —
  // let Create proceed and rely on Evaluate to catch any invented content.
  if (ledger.nodeOutputs.some((o) => o.nodeType === "investigate")) return true;

  // No Investigate node ran — require at least some user-provided verified facts.
  const userFacts = ledger.facts.filter((fact) => fact.verified && fact.sourceType !== "investigate");
  const joined = userFacts.map((fact) => fact.claim).join("\n").toLowerCase();
  const hasSkillOrRole = /\b(developer|designer|engineer|student|founder|creator|marketer|writer|photographer|skill|speciali[sz]e|build|built|work)\b/.test(joined);
  const hasProjectOrContact = /\b(project|portfolio|github|linkedin|email|contact|website|http|award|experience|volunteer)\b/.test(joined);
  return userFacts.length >= 2 && hasSkillOrRole && hasProjectOrContact;
}

export function missingPersonalFacts(): string[] {
  return [
    "Your verified role or headline",
    "At least 2 real projects, achievements, or experience items",
    "Skills or technologies you want shown",
    "Contact links/details to include, if any",
    "Whether images are real, decorative, or should be omitted",
  ];
}

export function evidenceGateMessage(ledger: RunLedger): string {
  const gaps = missingPersonalFacts();
  for (const gap of gaps) {
    if (!ledger.gaps.includes(gap)) ledger.gaps.push(gap);
  }
  return [
    "I need verified portfolio facts before generating the site, otherwise the Create node would have to invent personal content.",
    "",
    "Please reply with:",
    ...gaps.map((gap) => `- ${gap}`),
  ].join("\n");
}

export function ledgerSummary(ledger: RunLedger): string {
  const facts = ledger.facts.length > 0
    ? ledger.facts.slice(0, MAX_FACTS).map((fact) => (
      `- [${fact.id}] ${fact.claim} (source: ${fact.sourceType}:${fact.sourceRef}; verified: ${fact.verified ? "yes" : "no"})`
    )).join("\n")
    : "- None yet.";
  const gaps = ledger.gaps.length > 0
    ? ledger.gaps.map((gap) => `- ${gap}`).join("\n")
    : "- None recorded.";
  const outputs = ledger.nodeOutputs.length > 0
    ? ledger.nodeOutputs.slice(-5).map((output) => `- ${output.title}: ${output.summary}`).join("\n")
    : "- None yet.";

  return [
    `[Evidence Ledger: ${ledger.runId}]`,
    `Goal: ${ledger.goal || "(not specified)"}`,
    "Verified facts:",
    facts,
    "Open gaps:",
    gaps,
    "Recent node summaries:",
    outputs,
    "",
    "Evidence policy: use verified facts only for personal claims. Do not invent names, roles, projects, awards, contact details, URLs, social links, metrics, testimonials, or images.",
  ].join("\n");
}

export function personalArtifactFailure(output: string, ledger: RunLedger): string | null {
  const verifiedText = ledger.facts
    .filter((fact) => fact.verified && fact.sourceType !== "investigate")
    .map((fact) => fact.claim)
    .join("\n")
    .toLowerCase();
  const matched = SPECULATIVE_PERSONAL_PATTERNS
    .filter((pattern) => pattern.test(output) && !pattern.test(verifiedText))
    .map((pattern) => pattern.source);
  if (matched.length === 0) return null;
  return `Artifact contains unsupported personal portfolio content (${matched.slice(0, 5).join(", ")}). Remove invented facts or provide verified evidence. Ledger has ${ledger.facts.filter((f) => f.verified).length} verified fact(s).`;
}

export function extractUserFactsFromMessage(text: string): string {
  return compact(text, 1200);
}
