# Claude Handoff AB2

## Project State

- Repo: `/Users/helios/canview`
- Branch: `major-node-switch`
- App: DISPATCH.AI, motto/spec direction: "The visual agent platform."
- Current dev server was restarted after the latest chatbot protocol changes and served successfully on `http://localhost:3000`.
- Local network URL printed by server: `http://10.72.22.204:3000`
- Worktree is very dirty. Do not assume every change belongs to one agent/session. Preserve existing changes unless explicitly asked to revert.

## Product Direction

DISPATCH.AI is a canvas-first visual agent platform for building, debugging, reviewing, and running AI workflows. The canvas is the main surface. Chat should act as the orchestrator/copilot that edits the graph, explains problems, and helps run or repair chains without inventing unsupported content.

Current workflow concept:

```text
Initialiser -> Investigate -> Plan -> Design -> Create -> Evaluate -> Materialize
```

Supported node families currently in the codebase:

- `initialiser`
- `investigate`
- `plan`
- `design`
- `create`
- `evaluate`
- `doc`
- `materialize`
- `context`
- `review`

Important edge kinds:

- `flow`: main chain execution
- `midput`: context injection
- `reject`: review rejection branch

## Specs Implemented Or Partially Implemented

### Evidence-Grounded Portfolio Pipeline

Implemented a first pass of evidence grounding for personal portfolio workflows.

Key pieces:

- Added `EvidenceFact`, `RunLedger`, `RunLedgerNodeOutput`, `EvidenceSourceType`, and `EvidenceConfidence` in `shared/types.ts`.
- Added run ledger helpers in `server/features/execution/evidence.ts`.
- Added compact ledger persistence in `server/features/state/runLedgerStore.ts`.
- The execution engine now creates a ledger per run, injects compact ledger summaries into SDLC node prompts, records node summaries, and emits ledger update events.
- Personal portfolio chains now have pre-Create checks intended to prevent speculative personal content.
- Added authenticity checks for fake personal portfolio content such as generic projects, fake awards, example emails, stock portrait claims, and placeholder filler.
- Added a capped post-Evaluate repair path concept: failed Evaluate output can send issues back to Create, capped at two repair attempts.

Important files:

- `server/features/execution/engine.ts`
- `server/features/execution/evidence.ts`
- `server/features/state/runLedgerStore.ts`
- `server/features/ws/handlers/chain.ts`
- `src/whiteboard/hooks/useSocket.ts`
- `skills/investigate.md`
- `skills/plan.md`
- `skills/design.md`
- `skills/create.md`
- `skills/evaluate.md`
- `tests/node-v2.test.ts`

### Chat Orchestrator / Protocol Improvements

Implemented durable chat memory and safer graph-edit protocol after a reconnect/new session forgot context and the model produced invalid edge IDs.

Key changes:

- `chatMessages` now persist in `.dispatch/workspace-state.json`.
- `handleJoin` sends `chatMessages` in the websocket `init` payload.
- Frontend hydrates the chat panel from `init.chatMessages`.
- Backend model history now reads the persisted workspace transcript instead of per-socket `WeakMap` history.
- Graph serializer now includes real edge IDs and endpoint node IDs, so the model can see actual references.
- Added safer graph operation intents:
  - `delete_edge_between`
  - `insert_node_between`
- Chat apply/model proposals now normalize node references by:
  - exact node ID
  - exact node title
  - unique node type
- Chat apply/model proposals now normalize fake synthetic edge IDs like:
  - `sourceId-targetId`
  - `sourceId->targetId`
  - `sourceId:targetId`
- This specifically addresses the failure where the model tried to add a review gate and errored:

```text
Edge not found: "node_mq7fmcgj_hzygwold-node_mq7fmcgk_xduscfdt"
```

Important files:

- `shared/types.ts`
- `server/features/state/store.ts`
- `server/features/ws/handlers/join.ts`
- `server/features/ws/handlers/chat.ts`
- `server/features/chat/chatProvider.ts`
- `server/features/chat/graphSerializer.ts`
- `server/features/chat/graphSimulator.ts`
- `src/whiteboard/hooks/useSocket.ts`
- `src/whiteboard/Whiteboard.tsx`
- `src/whiteboard/components/Sidebar.tsx`
- `src/whiteboard/components/ChatPanel.tsx`
- `tests/node-v2.test.ts`

### Materialize / File-Map Safety

Implemented guardrails to stop Materialize from writing garbage when upstream output is not a real file map.

Key changes:

- `Create` skill now says file-producing code/site tasks must output file-map blocks only.
- `Evaluate` skill now says passing file-producing work must pass through the full file map.
- Engine blocks Materialize if upstream `Create` or `Evaluate` does not provide `--- FILE: path ---` blocks.
- `materializeSafe.ts` gives clearer errors when it receives an Evaluate PASS without file delimiters.

Important files:

- `server/features/execution/materializeSafe.ts`
- `server/features/execution/engine.ts`
- `skills/create.md`
- `skills/evaluate.md`
- `tests/node-v2.test.ts`

### OpenAI Tool Container Fix

Fixed the earlier Responses API error:

```text
400 Invalid 'tools[1].container': 'auto'. Expected an ID that begins with 'cntr'.
```

The code interpreter tool now uses the correct container shape:

```ts
container: { type: "auto" }
```

Important file:

- `server/features/execution/provider.ts`

### Review Gates

Review node support exists.

Key pieces:

- `review` node type exists in `shared/nodeRegistry.ts`.
- `review:respond` websocket handler exists in `server/features/ws/handlers/review.ts`.
- `reviewStore.ts` tracks pending review promises.
- Engine pauses on review nodes and waits for approve/reject/request-changes.
- Bottom panel has review UI.
- Chat protocol now supports inserting a review node between two existing nodes using `insert_node_between`.

Important files:

- `server/features/state/reviewStore.ts`
- `server/features/ws/handlers/review.ts`
- `server/features/execution/engine.ts`
- `src/whiteboard/components/BottomPanel.tsx`
- `src/whiteboard/render.ts`

## Current Critical Unfixed Issues

### 1. Evaluate -> Materialize Contract Is Still Wrong

Latest observed failure:

```text
Running: Evaluate Portfolio Website
Error in "Evaluate Portfolio Website":
Evaluate "Evaluate Portfolio Website" feeds Materialize but did not pass through any file blocks.
A PASS verdict before Materialize must include the complete Create file map using --- FILE: path --- delimiters.
```

What happened:

- Create likely produced the real file-map artifact.
- Evaluate returned a PASS/review-style answer without re-emitting the full file map.
- Materialize was correctly blocked because it had no files to write.

This is a protocol design bug. Do not keep trying to prompt Evaluate harder as the main fix.

Recommended fix:

- Store Create's last valid file-map artifact separately in the run context/ledger/artifact buffer.
- Evaluate should output only:
  - `PASS` / `FAIL`
  - issues
  - repair instructions
- If Evaluate passes, Materialize should write the last valid Create artifact, not Evaluate's prose.
- If Evaluate fails, retry Create with evaluator issues and ledger context.
- Materialize should consume an explicit artifact reference, not arbitrary previous-node text.

Target shape:

```text
Create -> artifact:fileMap
Evaluate -> verdict
if verdict PASS: Materialize(fileMapArtifact)
if verdict FAIL: Create(repairContext) -> Evaluate again
```

### 2. Ledger Events Are Duplicated

Terminal currently shows duplicate ledger updates:

```text
Ledger updated: 9 facts, 0 gaps, 1 node summaries
Ledger updated: 9 facts, 0 gaps, 1 node summaries
```

This is probably because both `ledger:updated` and a `chain:log` mirror are shown, or the engine emits ledger update callbacks twice around node transitions.

Impact:

- Not the cause of chain failure.
- Makes the terminal feel noisy and less trustworthy.

Recommended fix:

- Choose one user-visible ledger log path.
- Keep `ledger:updated` for structured UI state.
- Avoid echoing the same event as `chain:log`, or debounce by runId/factCount/nodeOutputCount.

### 3. Personal Portfolio Evidence Gate Is Too Weak

The latest run showed:

```text
Investigate Adam Bell
Ledger updated: 9 facts, 0 gaps
```

Concern:

- The system may still accept investigated/search-derived claims as "verified enough" for a personal portfolio.
- User's source policy is stricter: personal sites should not invent or over-trust vague public search guesses.

Recommended fix:

- Treat user-provided facts as highest authority.
- Treat public search facts about a person as candidate facts unless source confidence/provenance is explicit.
- For personal portfolio workflows, require explicit user approval or a review gate after Investigate before Plan/Create can use researched personal facts.
- Add a `needs_user_approval` or `approved` field to facts or ledger decisions.
- The chatbot should strongly prefer inserting a Review node after Investigate for personal portfolio chains.

### 4. Chat Memory Persists, But Workspace Recall Is Still Shallow

Implemented:

- Chat transcript persistence and frontend hydration.

Still missing:

- A real workspace memory index.
- Ability for chat to ask "what do we know about Adam?" and retrieve:
  - ledger facts from previous runs
  - artifact metadata
  - review decisions
  - current node outputs summaries
  - last successful file-map artifact

Recommended fix:

- Add a `workspaceMemory` object to `.dispatch/workspace-state.json` or separate `.dispatch/memory/*.json`.
- Persist compact durable memories:
  - approved facts
  - rejected facts
  - artifact refs
  - user preferences
  - project goals
  - review decisions
- Feed this into chat prompt separate from chat transcript.

### 5. Pending Chat Apply Cards Are Not Persisted

Intentional current behavior:

- Chat transcript persists.
- Pending operation cards do not persist.

Why:

- Applying stale graph operations after reload is unsafe.

Possible future improvement:

- Persist pending proposals as "expired drafts" with a revalidate button.
- On reload, require re-simulation against current graph before enabling Apply.

### 6. Initialiser Content Is Still Empty In Some Existing Workspaces

Observed `.dispatch/workspace-state.json` had:

```json
"type": "initialiser",
"config": {
  "workspacePath": "portfolio/adam-bell",
  "content": ""
}
```

Impact:

- Runs start with weak source-of-truth.
- The pipeline leans too hard on Investigate.

Recommended fix:

- Chat build templates must always seed Initialiser `content` with:
  - original user request
  - verified facts supplied by user
  - explicit missing facts
- Add a migration/repair command: if Initialiser content is empty but chat history has the original request, offer to restore it.

### 7. No Strong Artifact Store Yet

Run ledger persistence stores compact summaries and avoids raw huge outputs. Good.

Missing:

- A first-class artifact store for large Create outputs.
- Stable artifact IDs.
- Materialize consuming artifact IDs.
- Artifact previews/diffs wired to artifact IDs.

Recommended structure:

```text
.dispatch/artifacts/
  <runId>/
    create-<nodeId>-filemap.json
    create-<nodeId>-summary.json
```

Then ledger stores:

```json
{
  "artifactId": "...",
  "type": "fileMap",
  "createdByNodeId": "...",
  "hash": "sha256:..."
}
```

### 8. Chat Toolset Is Still Too Low-Level

Even with `insert_node_between`, the chatbot still mainly manipulates raw operations.

Recommended higher-level tools:

- `inspect_graph`
- `explain_graph`
- `validate_graph`
- `insert_review_gate`
- `add_context_url`
- `build_template`
- `repair_chain`
- `set_initialiser_context`
- `run_chain`
- `retry_from_failed_node`
- `summarize_last_run`
- `materialize_last_passed_artifact`

The model should express intent, and the server should convert intent to graph operations.

## Tests / Verification Last Run

These passed after the latest protocol changes:

```text
npx tsc --noEmit --pretty false
npm test
npm run build
git diff --check -- <touched files>
```

Test count after latest run:

```text
27 tests passed
```

Note:

- Tests cover chat transcript hydration, edge ID serialization, synthetic edge ID resolution, and `insert_node_between`.
- They do not yet cover the artifact-store fix because it is not implemented.

## Suggested Next Implementation Order

1. Implement first-class artifact storage for Create file maps.
2. Change Evaluate so it returns verdict/issues only.
3. Change Materialize to consume last passed Create artifact, not Evaluate text.
4. Add tests for:
   - Create stores file-map artifact.
   - Evaluate PASS without file map still allows Materialize via stored artifact.
   - Evaluate FAIL blocks Materialize and retries Create with issues.
   - Materialize refuses if no valid artifact exists.
5. De-duplicate ledger terminal logs.
6. Strengthen personal portfolio verified-only policy with approval/review semantics.
7. Add workspace memory beyond chat transcript.

## Files Most Likely To Touch Next

- `shared/types.ts`
- `server/features/execution/engine.ts`
- `server/features/execution/evidence.ts`
- `server/features/execution/materializeSafe.ts`
- `server/features/state/runLedgerStore.ts`
- new: `server/features/state/artifactStore.ts`
- `server/features/ws/handlers/chain.ts`
- `server/features/ws/handlers/chat.ts`
- `src/whiteboard/hooks/useSocket.ts`
- `src/whiteboard/components/BottomPanel.tsx`
- `tests/node-v2.test.ts`

## Warning For Claude

The latest visible chain failure is not because Materialize is too strict. Materialize is correctly preventing a bad write. The broken part is the data contract between Create, Evaluate, and Materialize. Fix that by separating artifacts from verdicts.
