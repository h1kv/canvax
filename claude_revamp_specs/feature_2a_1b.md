# Feature 2A-1B: Chat Orchestrator

## Summary

The chat model should become the main workflow orchestrator for DISPATCH.AI.

It should help users create, edit, validate, run, debug, and repair visual agent workflows through natural language. It should not behave like an uncontrolled canvas mutator. Every canvas-changing action should be represented as a typed operation plan, validated, and then applied.

## Product Role

Chat is the workflow copilot.

It should understand:

- the user's intent
- the current graph
- selected nodes
- run history
- terminal output
- node errors
- materialized files
- workspace constraints

It should help users move from vague intent to a valid executable workflow.

## Core Capabilities

### 1. Create Workflows From Intent

Chat should turn natural language requests into workflow plans.

Example:

```text
User: Build me a repo research pipeline.
```

Chat should propose a chain such as:

```text
Initialiser -> Investigate -> Plan -> Create -> Evaluate -> Materialize
```

The assistant should present the plan first, then apply it depending on the current interaction mode.

### 2. Explain The Graph

Chat should explain the current workflow in plain language.

It should be able to answer:

- What does this workflow do?
- Where does data flow?
- What does each node contribute?
- Which nodes are unused?
- What is the likely output?

### 3. Validate The Graph

Chat should detect graph issues before execution.

Validation should catch:

- missing Initialiser
- more than one Initialiser
- Initialiser with no flow edge
- broken flow edges
- orphan SDLC nodes
- Context connected as `flow` instead of `midput`
- missing task prompts
- missing workspace path
- Materialize with no upstream file-producing node
- cycles if unsupported
- unreachable nodes

### 4. Repair The Graph

Chat should suggest or apply repairs.

Examples:

- Add missing flow edges.
- Insert `Evaluate` before `Materialize`.
- Convert invalid Context flow edges into `midput` edges.
- Add missing Context nodes.
- Remove unreachable nodes.
- Rename unclear nodes.
- Fill missing task prompts.

Repair should still use typed operation plans and graph validation.

### 5. Edit Selected Nodes

Chat should modify selected nodes safely.

Supported edits:

- rewrite `taskPrompt`
- set Initialiser `workspacePath`
- rename nodes
- update Context content
- summarize long Context content
- clear node output
- reset node status

### 6. Generate Chain Templates

Chat should create common workflows quickly.

Useful templates:

- website build
- research report
- code review
- bug investigation
- docs generation
- test and repair
- repo analysis
- landing page generation
- safe materialization workflow

Templates should be deterministic enough to avoid random graph shapes.

### 7. Run Commands Through Intent

Chat should map natural language to execution commands.

Examples:

```text
Run this chain.
Stop the run.
Retry from Create.
Retry the failed node.
Show me the error.
Open the terminal.
```

The assistant should call the corresponding workflow command rather than inventing graph changes.

### 8. Debug Failures

Chat should read terminal logs, node statuses, node outputs, and run history to explain failures.

It should answer:

- What failed?
- Which node failed?
- Why did it fail?
- What context was used?
- What should I do next?

It should suggest a repair action when possible.

### 9. Retry Intelligently

Chat should help retry failed nodes.

It should be able to:

- update the failed node prompt using error context
- preserve upstream successful outputs
- retry only the failed node
- retry from the failed node onward
- reset downstream nodes when needed

Example:

```text
User: Fix and retry.
```

Chat should inspect the failed node, explain the fix, update the prompt if needed, and retry from that node.

### 10. Review Outputs

Chat should review node outputs against the original goal.

It should be able to:

- summarize output
- identify weak spots
- compare output against the user request
- suggest downstream nodes
- recommend whether to Materialize

### 11. Prepare Safe Writes

Chat should help with Materialize write planning.

It should:

- explain which files will be written
- summarize diffs
- warn about overwrites
- point out unsafe paths
- request approval before applying risky writes

Chat should never bypass safe write validation.

### 12. Manage Context

Chat should create and connect Context nodes correctly.

Supported inputs:

- URLs
- pasted text
- file paths
- search queries
- repo facts

Context nodes should connect to SDLC nodes via `midput`, not normal `flow`.

### 13. Preserve The Goal

Chat should remember the user's original goal for the workflow.

That goal should be used when:

- filling task prompts
- evaluating outputs
- repairing failures
- deciding whether the workflow is complete

## Operation Plan Requirement

Chat must not freehand mutate canvas state.

For any graph-changing request, chat should produce a typed operation plan internally.

Example operation categories:

```ts
type ChatGraphOperation =
  | { op: "create_node"; nodeType: NodeV2Type; position: Point; title?: string; config?: NodeV2Config }
  | { op: "update_node"; nodeId: string; title?: string; config?: Partial<NodeV2Config> }
  | { op: "delete_node"; nodeId: string }
  | { op: "create_edge"; sourceId: string; targetId: string; kind: EdgeV2Kind }
  | { op: "delete_edge"; edgeId: string }
  | { op: "run_chain" }
  | { op: "stop_chain" }
  | { op: "retry_node"; nodeId: string }
  | { op: "retry_from_node"; nodeId: string };
```

Before applying operations:

1. Build the operation plan.
2. Validate operation shape.
3. Simulate the resulting graph.
4. Run graph validation.
5. Present summary to user when required.
6. Apply only if valid.

## Interaction Modes

Chat should support at least three modes:

- `Plan`: describe proposed changes but do not apply.
- `Review`: show operation plan and wait for confirmation.
- `Auto`: apply valid low-risk changes automatically.

High-risk actions should always require confirmation:

- file writes
- shell commands
- git operations
- deleting nodes
- overwriting files
- deploying

## Non-Goals

- Chat should not bypass graph validation.
- Chat should not write files directly.
- Chat should not run shell commands directly without the correct node or tool path.
- Chat should not create hidden nodes or edges.
- Chat should not mutate state using untyped JSON blobs.
- Chat should not claim it changed the canvas unless the operation actually applied.

## Acceptance Criteria

- Chat can explain the current graph.
- Chat can create a valid workflow from a common user request.
- Chat can update selected node prompts and config.
- Chat catches invalid graphs before run.
- Chat repairs common graph problems.
- Chat can retry a failed node using run history.
- Chat can summarize terminal errors.
- Chat creates Context nodes with `midput` edges.
- Chat never applies invalid operation plans.
- Chat never silently bypasses safe write review.
