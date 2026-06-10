import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunLedger } from "../../../shared/types.js";

const RUN_LEDGER_DIR_NAME = "run-ledgers";
let runLedgerDirOverride: string | null = null;
let persistenceSuspended = false;

function runLedgerDir(): string {
  if (runLedgerDirOverride) return runLedgerDirOverride;
  if (process.env.DISPATCH_RUN_LEDGER_DIR) return process.env.DISPATCH_RUN_LEDGER_DIR;
  return path.join(process.cwd(), ".dispatch", RUN_LEDGER_DIR_NAME);
}

function cap(text: string, limit = 900): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function compactLedger(ledger: RunLedger, status: "complete" | "error" | "needs_input"): RunLedger & {
  status: "complete" | "error" | "needs_input";
  savedAt: string;
} {
  return {
    ...ledger,
    status,
    savedAt: new Date().toISOString(),
    goal: cap(ledger.goal, 400),
    facts: ledger.facts.slice(0, 40).map((fact) => ({ ...fact, claim: cap(fact.claim, 300) })),
    gaps: ledger.gaps.slice(0, 30).map((gap) => cap(gap, 200)),
    nodeOutputs: ledger.nodeOutputs.slice(-20).map((output) => ({
      ...output,
      summary: `[${Buffer.byteLength(output.summary, "utf-8")} bytes, sha256:${sha256(output.summary)}]`,
    })),
    artifactSummaries: ledger.artifactSummaries.slice(-20).map((summary) => cap(summary, 400)),
    evaluationIssues: ledger.evaluationIssues.slice(-20).map((issue) => cap(issue, 500)),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ledgerFile(): string {
  return path.join(runLedgerDir(), "run-ledger.jsonl");
}

export function persistRunLedger(
  ledger: RunLedger,
  status: "complete" | "error" | "needs_input"
): boolean {
  if (persistenceSuspended) return false;
  const dir = runLedgerDir();
  const filePath = path.join(dir, `${ledger.runId}.json`);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(compactLedger(ledger, status), null, 2)}\n`, "utf-8");
    writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(compactLedger(ledger, status), null, 2)}\n`, "utf-8");
    if (existsSync(tmpPath)) {
      // keep the per-run write atomic; latest.json is best-effort convenience.
      renameSync(tmpPath, filePath);
    }
    return true;
  } catch (err) {
    console.warn("[run-ledger] failed to save", err);
    return false;
  }
}

export function appendRunLedgerEvent(event: Record<string, unknown>): boolean {
  if (persistenceSuspended) return false;
  try {
    mkdirSync(runLedgerDir(), { recursive: true });
    appendFileSync(ledgerFile(), `${JSON.stringify(event)}\n`, "utf-8");
    return true;
  } catch (err) {
    console.warn("[run-ledger] failed to append", err);
    return false;
  }
}

export function setRunLedgerDirForTests(dir: string | null): void {
  runLedgerDirOverride = dir;
  persistenceSuspended = dir === null;
}

export function resetRunLedgerStoreForTests(): void {
  runLedgerDirOverride = null;
  persistenceSuspended = true;
}
