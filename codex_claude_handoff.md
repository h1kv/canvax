# DISPATCH.AI — Codex to Claude Handoff

Date: 2026-06-09
Workspace: `/Users/helios/canview`

## Situation

The user is moving development from Codex to Claude. The repo has a large uncommitted working tree from today's work. Do not assume anything is committed, and do not revert unrelated changes.

Latest verification status:

```bash
./node_modules/.bin/tsc --noEmit
npm run build
git diff --check
```

All three pass as of this handoff.

Browser visual smoke testing was not completed because the in-app browser control tool was not exposed in the Codex session. Please verify the UI manually in Chrome after restarting the dev server.

## Product Direction

DISPATCH.AI is a visual workflow builder for AI agent chains.

The executable Canvas is the product center. It should not feel like a static diagram or a chat-generated mock flow. The user wants to orchestrate agents visually because chat loops are exhausting.

Core direction:

- Canvas nodes should be real executable agent/runtime units.
- Agent nodes should use live tools when useful.
- Tool access should be configurable per node.
- Risky tool calls need approval gates.
- Plan mode is useful, but secondary to making executable canvas orchestration excellent.
- Chat should be able to read, create, and edit both canvas and plan context over time.

## High-Level Completed Work

### Rebrand

Visible app/docs were changed from Canvax/canvax to **DISPATCH.AI**.

Relevant files:

- `index.html`
- `server/index.ts`
- `src/App.tsx`
- `src/whiteboard/components/TitleBar.tsx`
- `src/shelf/drawing/LegacyWhiteboard.jsx`
- `tools.md`
- `codex_handoff.md`

### Task Prompt Refactor

Agent node editable text is now `taskPrompt`, meaning the task-at-hand prompt. The internal role skill remains system/developer behavior.

Legacy `systemPrompt` is still read as fallback for compatibility.

Relevant files:

- `server/execution/engine.ts`
- `src/whiteboard/components/Sidebar.tsx`
- `src/whiteboard/render.ts`
- `src/whiteboard/config/nodeTypes.ts`

### OpenAI Provider Fixes

OpenAI calls now:

- default to `gpt-5.5`
- use `max_completion_tokens`
- omit custom `temperature`, because `gpt-5.5` rejects `temperature: 0.7`
- send internal instructions as `developer`
- read optional `OPENAI_MAX_COMPLETION_TOKENS`, defaulting to `8192`

Relevant file:

- `server/execution/providers/openai.ts`

### Start Node Defaults

The Start node default provider/model are used as fallback for agent and branch nodes.

Relevant files:

- `server/execution/engine.ts`
- `src/whiteboard/config/nodeTypes.ts`

### File Write Path Safety

File Write resolves paths inside the workspace. Root-looking paths such as `/testing_grounds/page.html` normalize into:

```text
/Users/helios/canview/testing_grounds/page.html
```

Relevant files:

- `server/execution/engine.ts`
- `server/execution/agentTools.ts`
- `tools.md`
- `server/ws/handlers/chat.ts`

## Phase 3 Runtime Slice Completed

### Agent Tools

New file:

- `server/execution/agentTools.ts`

Agent nodes now support:

- `config.tools`: per-node allowlist
- `config.maxToolCalls`: max live tool calls for one node execution

Available tools:

- `web_search`
- `fetch_url`
- `read_file`
- `write_file`
- `list_files`
- `shell_exec`

Default agent tools:

```json
{
  "tools": ["web_search", "fetch_url"],
  "maxToolCalls": 6
}
```

### Native OpenAI Tool Calling

OpenAI agent nodes now use native Chat Completions tool calls instead of relying on raw JSON text.

Relevant files:

- `server/execution/providers/openai.ts`
- `server/execution/engine.ts`
- `server/execution/agentTools.ts`

Important details:

- `callOpenAIToolRound()` sends `tools` with JSON schemas.
- `parallel_tool_calls: false` is set so the visual runtime gets deterministic, sequential tool events.
- Tool results are returned as `role: "tool"` messages with `tool_call_id`.
- Final OpenAI outputs should no longer leak `{"toolCall": ...}` JSON in normal native-tool runs.
- Non-OpenAI providers still use the JSON fallback loop for now.

### Run Trace Ledger

Trace state is now separate from `BoardNode`. This is important: node output is final/user-facing result, trace is execution telemetry.

Relevant files:

- `src/types/index.ts`
- `server/state/store.ts`
- `server/ws/handlers/chain.ts`
- `server/ws/handlers/join.ts`
- `src/whiteboard/hooks/useSocket.ts`

Trace messages:

```text
node:traces:reset
node:trace
chain:started
chain:complete
chain:stopped
chain:error
```

Trace event kinds include:

- `chain:started`
- `chain:completed`
- `chain:stopped`
- `node:started`
- `node:status`
- `node:input`
- `node:output`
- `node:model`
- `node:tool-call`
- `node:tool-result`
- `node:tool-error`
- `review:waiting`
- `review:decision`
- `node:error`

### Trace UI

The canvas now has two trace surfaces:

- Sidebar `Run Trace` timeline, chronological and compact.
- Per-node trace chips directly on canvas nodes, e.g. `model`, `tool: web_search`, `done: fetch_url`, `error`.

Relevant files:

- `src/whiteboard/components/Sidebar.tsx`
- `src/whiteboard/hooks/useRender.ts`
- `src/whiteboard/render.ts`
- `src/styles.css`
- `src/whiteboard/Whiteboard.tsx`

### Chat-Created Agent Config Defaults

Server-side node config normalization now merges defaults so chat-created agent nodes do not silently lose live tools.

Relevant file:

- `server/state/operations.ts`

Behavior:

- Missing/non-array agent `tools` falls back to defaults.
- Valid arrays are deduped and filtered.
- Explicit empty `tools: []` is preserved as "no tools".
- Invalid non-empty arrays fall back to defaults.
- `maxToolCalls` is clamped to `0..20`.

## Plan Workspace

A separate **Plan** tab exists beside executable Canvas.

Plan graph types:

- `PlanNode`
- `PlanEdge`

Plan node kinds:

- `note`
- `task`
- `decision`
- `risk`
- `flow-step`
- `proposed-agent`
- `proposed-tool`
- `approval-point`
- `context`

Plan workspace has:

- canvas renderer
- Plan toolbar
- Plan sidebar inspector
- websocket CRUD
- chat `planOperations`

Relevant files:

- `src/types/index.ts`
- `server/state/store.ts`
- `server/state/operations.ts`
- `server/ws/handlers/plan.ts`
- `server/ws/dispatch.ts`
- `server/ws/handlers/join.ts`
- `src/whiteboard/renderPlan.ts`
- `src/whiteboard/hooks/usePlanRender.ts`
- `src/whiteboard/hooks/usePlanInteraction.ts`
- `src/whiteboard/components/PlanCanvas.tsx`
- `src/whiteboard/components/PlanSidebarPanel.tsx`
- `src/whiteboard/Whiteboard.tsx`
- `src/whiteboard/components/Sidebar.tsx`
- `src/styles.css`

Chat sees both canvas and Plan graph snapshots and can return:

- `operations` for executable Canvas
- `planOperations` for Plan workspace

Plan chat first turn cannot mutate immediately; it asks questions or falls back to a preview.

## WebSocket / Cursor Changes

Plan graph state is included in `init`.

New websocket messages:

```text
plan:node:create
plan:node:update
plan:node:delete
plan:edge:create
plan:edge:delete

plan:node:created
plan:node:updated
plan:node:deleted
plan:edge:created
plan:edge:deleted
```

Cursor updates include `workspaceTab` so Plan cursors do not appear on Canvas and vice versa.

Relevant files:

- `server/ws/handlers/cursor.ts`
- `src/whiteboard/hooks/useSocket.ts`
- `src/whiteboard/render.ts`
- `src/whiteboard/renderPlan.ts`

## Layout Fix Attempt

The user saw the canvas cut off with a large white blank region at the bottom of the viewport.

A CSS fix was applied:

- `body { overflow: hidden; }`
- `.vsc-shell { height: 100dvh; min-height: 0; }`
- `.vsc-workspace { height: 100%; }`
- `.vsc-editor { width: 100%; height: 100%; }`

Relevant file:

- `src/styles.css`

This still needs visual verification in Chrome.

## Current Git State

There are many uncommitted changes. Important untracked files:

```text
server/execution/agentTools.ts
server/ws/handlers/plan.ts
src/whiteboard/components/PlanCanvas.tsx
src/whiteboard/components/PlanSidebarPanel.tsx
src/whiteboard/hooks/usePlanInteraction.ts
src/whiteboard/hooks/usePlanRender.ts
src/whiteboard/renderPlan.ts
codex_claude_handoff.md
```

There is also an untracked `.claude/` directory. Inspect before touching.

## Dependency Changes

Added dev typings:

```bash
npm install -D @types/express @types/ws
```

Relevant files:

- `package.json`
- `package-lock.json`

## Known Gaps / Next Work

### Highest Priority

1. Restart the dev server and visually validate the canvas.
2. Run an Investigate agent node and confirm `web_search` / `fetch_url` tool calls appear in the sidebar trace and node chips.
3. Validate the bottom whitespace/cutoff bug is fixed in Chrome.
4. Implement approval-gated tool calls for risky tools.
5. Improve research quality beyond "it used a search tool."

### Approval Gates Still Missing

Risky tools are workspace-constrained but not approval-gated yet:

- `write_file`
- `shell_exec`

Recommended architecture from earlier audit:

- Do not reuse Review nodes or `review:*` messages.
- Add separate `tool:approval:*` websocket messages.
- Gate after allowlist check and before `executeAgentTool()`.
- Keep the agent node `running`; do not set it to `paused`.
- Denial should return a tool-result string to the model, e.g. `Tool denied by reviewer`.
- Store raw args server-side; client approves/rejects by `approvalId`.

### Research Quality Still Needs Work

Native OpenAI tool calling should prevent raw JSON leakage, but research quality is not fully solved.

Remaining work:

- Treat `web_search` results as leads, not citations.
- Encourage or require `fetch_url` after search before final research output.
- Track fetched source pages in an evidence registry.
- Prefer real source-page URLs, not search result URLs.
- Add a final-output gate for research nodes:
  - no raw tool JSON
  - no `[Tool Result]` leakage
  - no citations to unfetched URLs
  - acknowledge uncertainty when source pages are weak

### Runtime / Trace Gaps

- Trace state is in-memory only.
- Trace UI is compact, not expandable yet.
- No per-tool approval UI.
- No persisted run history.
- No streaming model deltas, only turn-level events.
- Non-OpenAI providers still use JSON fallback tool protocol.

### Plan Workspace Gaps

- Plan graph is in-memory only.
- Plan edge labels cannot be edited in-place.
- Mobile Plan editing is incomplete because the sidebar is hidden on small screens.
- Plan context blocks are visible to chat but not yet wired into an executable planning context resolver.

### Chat Gaps

- Chat history is local/session-only.
- Review apply still says generic `Changes applied` rather than applied/skipped counts.
- Chat can create canvas/plan structures, but deeper AI-native editing of trace/history/context is still future work.

## Things To Be Careful About

- Do not revert the dirty working tree unless the user explicitly asks.
- Do not assume Plan workspace equals executable Canvas. Keep states separate.
- The executable Canvas is the product center.
- Restart the dev server after backend changes.
- Use workspace-relative file paths in generated File Write configs.
- File/shell tools must remain workspace-constrained.
- Approval gates should be separate from Review nodes.

## Useful Commands

```bash
npm install
npm run dev
./node_modules/.bin/tsc --noEmit
npm run build
git diff --check
git status --short
```

Dev server defaults:

```text
http://localhost:3000
```

Can run on another port:

```bash
PORT=3100 npm run dev
```

## Suggested Next Claude Task

Start by validating this exact workflow:

1. Restart dev server.
2. Create or use a Start node with a research task.
3. Create or use an Agent node with role `Investigate`.
4. Confirm `Live Tools` has `Web Search` and `Fetch URL` checked.
5. Run the chain.
6. Confirm trace events appear in the sidebar `Run Trace`.
7. Confirm the agent node shows canvas trace chips such as `model`, `tool: web_search`, and `done: fetch_url`.
8. Confirm final node output does not include raw `{"toolCall": ...}` JSON.
9. Confirm the bottom viewport whitespace/cutoff issue is fixed.

Then implement approval-gated tool calls for `write_file` and `shell_exec`.
