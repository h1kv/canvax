# Execution Feature 1A: Safe Writes, Retry, and Review

## Summary

Execution Feature 1A makes DISPATCH.AI feel trustworthy as a developer tool. The focus is not adding more node types; it is making execution safer, recoverable, and reviewable.

This feature covers three connected capabilities:

- Safe file writes for `Materialize`
- Retry from failed node
- Human review checkpoints

Together, these prevent reckless AI file writes, reduce wasted reruns, and give the user control at important moments.

## Goals

- Never let AI output write arbitrary files on disk.
- Make every file write visible, previewable, and reversible where practical.
- Let users retry a failed node without rerunning successful upstream work.
- Preserve upstream context and node outputs between retries.
- Add a human review checkpoint that can approve, reject, or request changes.
- Surface all actions in terminal/run logs so execution is auditable.

## Safe File Writes

Safe file writes belong primarily to the `Materialize` node.

`Materialize` should never blindly write generated files to disk. It should parse generated file blocks, validate paths, preview changes, then write only after the write plan is safe.

### Required Behavior

- Write only inside the Initialiser `workspacePath`.
- Reject absolute paths.
- Reject home-relative paths such as `~/.ssh/config`.
- Reject path traversal such as `../`, `../../.env`, or any resolved path outside `workspacePath`.
- Reject writes to dangerous files by default:
  - `.env`
  - `.env.*`
  - private keys
  - `.ssh/**`
  - `.git/**`
  - package manager lockfiles unless explicitly allowed later
- Show a write preview before applying changes.
- Show whether each file will be created, modified, overwritten, or skipped.
- For modified files, provide a diff preview.
- Log every planned write and completed write to the terminal.
- Use atomic writes where possible: write to a temporary file, then rename.
- Enforce file size limits to avoid accidental huge writes.
- Detect likely secrets in generated content and warn before writing.

### Write Plan Shape

```ts
interface MaterializeWritePlan {
  workspacePath: string;
  files: MaterializeFilePlan[];
  warnings: string[];
  errors: string[];
  requiresApproval: boolean;
}

interface MaterializeFilePlan {
  relativePath: string;
  absolutePath: string;
  action: "create" | "modify" | "overwrite" | "skip";
  exists: boolean;
  bytes: number;
  diff?: string;
  warnings: string[];
}
```

### Materialize Flow

1. Read Initialiser `workspacePath`.
2. Parse upstream output for file blocks.
3. Build a write plan.
4. Validate every target path.
5. Generate diffs for existing files.
6. If write plan has errors, mark `Materialize` as `error`.
7. If write plan requires approval, pause for review.
8. After approval, write files atomically.
9. Mark `Materialize` as `done` with a summary of files written.

### Terminal Examples

```text
› Materialize: parsed 3 file blocks
› Materialize: create src/App.tsx
› Materialize: modify src/styles.css
⚠ Materialize: write requires approval
✓ Materialize: wrote 2 files
```

## Retry From Failed Node

Retry from failed node lets users recover from a failed execution without rerunning the whole chain.

If node 4 fails in a 7-node chain, nodes 1-3 should remain cached. The user should be able to edit the failed node prompt or config, then retry from that node using the same upstream context.

### Required Behavior

- Store a run record per node execution.
- Preserve successful upstream outputs.
- Preserve the exact input context used by the failed node.
- Allow retrying:
  - only the failed node
  - from the failed node onward
  - from any selected node onward
- Reset downstream node statuses when retrying from a node.
- Do not clear successful upstream outputs unless the user explicitly chooses to rerun upstream.
- Let the user edit the failed node `taskPrompt` or config before retrying.
- Log retry actions in the terminal.

### Run Record Shape

```ts
interface NodeRunRecord {
  runId: string;
  nodeId: string;
  status: "idle" | "running" | "done" | "error" | "skipped";
  inputContext: string;
  upstreamOutput: string | null;
  taskPrompt: string;
  output: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}
```

### Retry Options

- `Retry node`: rerun only the failed node.
- `Retry from here`: rerun this node and all downstream flow nodes.
- `Retry with output cleared`: clear this node output before rerun.
- `Retry with downstream reset`: clear all downstream statuses and outputs before continuing.

### Example

Graph:

```text
Initialiser -> Investigate -> Plan -> Create -> Evaluate
```

If `Create` fails:

1. `Investigate` remains `done`.
2. `Plan` remains `done`.
3. User edits `Create` task prompt.
4. User clicks `Retry Create`.
5. `Create` reruns with the same upstream `Plan` output.
6. User may continue to `Evaluate`.

## Human Review Node

The Review node is a human checkpoint. It pauses the chain and asks the user to approve, reject, or request changes before continuing.

This is the trust layer for risky actions.

### Good Review Points

- Before `Materialize` writes files.
- Before running shell commands.
- Before committing changes.
- Before deploying.
- After `Evaluate` reports concerns.
- Before expensive model calls.

### Required Actions

- `Approve`: continue the chain.
- `Reject`: stop the chain.
- `Request changes`: send review notes to a downstream refine/create step.
- `Edit payload`: allow manual edits before downstream nodes consume the output.

### Review Payload

```ts
interface ReviewRequest {
  reviewId: string;
  runId: string;
  nodeId: string;
  title: string;
  summary: string;
  details: string;
  relatedFiles?: MaterializeFilePlan[];
  evaluatorVerdict?: string;
  createdAt: number;
}
```

### Review Flow Example

```text
Create -> Evaluate -> Review -> Materialize
```

The Review panel should show:

- generated files
- evaluator verdict
- risks
- diff preview
- approve/reject/request changes actions

### Terminal Examples

```text
› Review: waiting for approval
✓ Review: approved by Adam
✕ Review: rejected by Adam
```

## UI Expectations

### Bottom Panel

The bottom panel should be the home for execution feedback.

Recommended tabs:

- `Terminal`: chronological logs
- `Problems`: node and graph errors
- `Output`: selected node output
- `Files`: pending or completed Materialize writes

The sidebar should configure the selected node. It should not be overloaded with long error strings, giant output blobs, or write diffs.

### Problems Panel

Problems should be clickable and jump to the related node.

Each problem should include:

- node title
- severity
- short cause
- suggested fix
- optional details

Example:

```text
Create failed: model returned no file blocks.
Suggested fix: ask Create to output files using --- FILE: path --- delimiters.
```

## Non-Goals

- Do not add broad deployment support yet.
- Do not allow arbitrary shell execution as part of this feature.
- Do not persist secrets in node config or workspace state.
- Do not write outside Initialiser `workspacePath`.
- Do not add a huge node catalog.

## Acceptance Criteria

- `Materialize` cannot write outside `workspacePath`.
- Existing file modifications show a diff before write.
- Unsafe paths fail with a clear error.
- Terminal logs every write plan and write result.
- Failed nodes can be retried without rerunning successful upstream nodes.
- Retrying from a node resets downstream status/output correctly.
- Review can pause a chain and continue only after approval.
- Rejecting review stops the chain.
- Review and Materialize actions are visible in terminal/run history.
