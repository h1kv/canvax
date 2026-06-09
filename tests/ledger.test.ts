import test from "node:test";
import assert from "node:assert/strict";
import {
  addLedgerFact,
  addLedgerSource,
  artifactQualityIssues,
  buildLedgerSummary,
  createRunLedger,
  recordNodeOutput,
  stripMarkdownFenceForPath,
  stripSingleMarkdownFence,
} from "../server/features/execution/ledger.js";

test("ledger summaries propagate context facts and prior outputs", () => {
  const ledger = createRunLedger("run_test", "Create a better website");
  const source = addLedgerSource(ledger, {
    nodeId: "ctx_1",
    kind: "context",
    label: "Context: jsumarketing.com",
    url: "https://jsumarketing.com/",
  });
  addLedgerFact(ledger, {
    nodeId: "ctx_1",
    sourceId: source.id,
    kind: "context",
    title: "Resolved URL context",
    content: "JSU Marketing provides marketing services for local businesses.",
    confidence: "high",
  });
  recordNodeOutput(ledger, {
    nodeId: "plan_1",
    role: "plan",
    label: "Plan site improvements",
    output: "Use the JSU Marketing service details in the hero and services section.",
  });

  const summary = buildLedgerSummary(ledger);

  assert.match(summary, /JSU Marketing provides marketing services/);
  assert.match(summary, /Plan site improvements/);
  assert.match(summary, /https:\/\/jsumarketing\.com\//);
});

test("raw artifact helpers strip only outer markdown fences for code-like paths", () => {
  const fenced = "```html\n<!doctype html>\n<title>JSU</title>\n```";

  assert.equal(stripSingleMarkdownFence(fenced), "<!doctype html>\n<title>JSU</title>\n");
  assert.equal(stripMarkdownFenceForPath("output/site.html", fenced), "<!doctype html>\n<title>JSU</title>\n");
  assert.equal(stripMarkdownFenceForPath("output/readme.md", fenced), fenced);
});

test("artifact quality gate fails placeholders when source evidence exists", () => {
  const html = "<!doctype html><h2>Project One</h2><p>A brief description of Project One.</p>";
  const issues = artifactQualityIssues(html, true);

  assert.ok(issues.some((issue) => /placeholder/i.test(issue)));
  assert.deepEqual(artifactQualityIssues("<!doctype html><h1>JSU Marketing</h1>", true), []);
});
