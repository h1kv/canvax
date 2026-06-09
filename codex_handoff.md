# DISPATCH.AI — Codex Handoff

Visual workflow builder for AI agent chains. React 19 + Vite 7 frontend, Express + WebSocket backend. Canvas rendered with HTML Canvas 2D API. DISPATCH.AI has two workspace surfaces: the executable canvas and the Plan workspace for shaping work before committing chain changes. No database — all state lives in-memory on the server and is broadcast via WebSocket.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Browser (React 19, Vite 7)                         │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────┐ │
│  │ Whiteboard│  │  Sidebar    │  │   ChatPanel    │ │
│  │ (canvas) │  │ (toolbox +  │  │ (Auto/Plan/    │ │
│  │          │  │  properties)│  │  Review modes) │ │
│  └──────────┘  └─────────────┘  └────────────────┘ │
│          ↕ WebSocket (JSON messages)                │
│  ┌─────────────────────────────────────────────────┐│
│  │  useSocket.ts — single WS connection            ││
│  │  CustomEvent "dispatch:chat" for chat responses ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
            ↕ ws://host/ws
┌─────────────────────────────────────────────────────┐
│  Server (Express + ws, tsx --env-file=.env)         │
│  ┌──────────────┐  ┌──────────────┐                │
│  │ state/store  │  │ execution/   │                │
│  │ (nodes, edges│  │ engine.ts    │                │
│  │  Map in-mem) │  │ (chain runner│                │
│  └──────────────┘  │  + AI calls) │                │
│                    └──────────────┘                │
│  ┌────────────────────────────────────────────────┐│
│  │  ws/dispatch.ts — routes all WS message types  ││
│  └────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## Plan Workspace

The Plan workspace is the non-executing planning layer beside the canvas. It captures the work structure before it becomes runnable nodes.

- `WorkspaceTab` supports `"canvas"` and `"plan"`.
- Plan v1 is a flat graph: `PlanNode` + `PlanEdge`, stored in-memory beside the executable `BoardNode` + `BoardEdge` graph.
- Plan nodes model notes, tasks, decisions, risks, flow steps, proposed agents/tools, approval points, and context.
- Plan edges model lightweight relationships between Plan nodes with an optional label.
- Chat uses a separate `planOperations` array so planning changes do not get mixed into executable canvas `operations`.

## Node Types

| ID | Label | Category | Color | Purpose |
|---|---|---|---|---|
| `start` | Start | start | `#16825d` | Entry point, task description |
| `agent` | Agent Step | ai-step | dynamic by role | AI call with selectable role |
| `review` | Review | review | `#e65100` | Human checkpoint (approve/reject) |
| `branch` | Condition | control | `#78909c` | AI-evaluated true/false route |
| `fork` | Parallel | control | `#7b1fa2` | Fan-out to N nodes simultaneously |
| `memory` | Memory | memory | `#c2185b` | Write/read in-chain key-value store |
| `context` | Context | context | `#f57c00` | Inject text/URL/search/file into AI nodes |
| `shell-exec` | Shell Execute | tool | `#37474f` | Run shell command, capture output |
| `file-write` | File Write | tool | `#5d4037` | Write/append text to disk |
| `tool` | API Request | tool | `#0097a7` | HTTP fetch |

### Agent Step Roles

The `agent` node has a `role` config field that selects the built-in skill prompt:

- `investigate` — research analyst
- `plan` — strategic planner
- `design` — senior designer
- `create` — expert creator
- `evaluate` — critical evaluator
- `document` — technical writer
- `custom` — freeform role slot for future skills

The editable agent prompt is `taskPrompt`: it is sent as the task at hand in the user message. The system prompt stays internal and comes from the selected role skill. Legacy `systemPrompt` config is still treated as task text for backwards compatibility.

Agent nodes also support a bounded live-tool loop. `config.tools` is an allowlist and `config.maxToolCalls` caps the loop. Available tools are `web_search`, `fetch_url`, `read_file`, `write_file`, `list_files`, and `shell_exec`; file and shell paths are resolved inside the workspace.

## Chain Execution

`server/execution/engine.ts — runChain()`

1. **Context pre-pass** — all `context` nodes resolved concurrently (fetch URL, read file, search web). Result injected into target nodes via `contextFor: Map<nodeId, ContextPayload[]>`. If `spreadToChain=true`, injects into all downstream nodes via BFS.

2. **Traversal** — DFS from Start node, following output port edges. Fork nodes run all outgoing edges with `Promise.all`.

3. **Per-node execution**:
   - `start` → outputs `taskDescription`
   - `agent` → builds internal developer instructions from role skill + context notes, calls AI with context content + chain input + taskPrompt in the user message, and runs a bounded tool loop when `config.tools` is non-empty
   - `review` → `waitForReview()` suspends until `review:approve/reject` WS arrives
   - `branch` → AI evaluates condition, routes `true`/`false`
   - `memory write` → stores input in `chainMemory` Map, passes through
   - `memory read` → outputs stored value from `chainMemory`
   - `fork` → passes input to all connected nodes in parallel
   - `shell-exec` → `child_process.exec`, captures stdout/stderr/exitCode
   - `file-write` → `fs.writeFile` / `appendFile`
   - `tool` → `fetch(url)` with configured method/headers/body

4. **`chainMemory`** — `Map<string, string>` scoped to one chain run, shared across all nodes in the run. Enables store-then-retrieve patterns.

## WebSocket Protocol

All messages are JSON. Server broadcasts to all connected clients.

```
Client → Server:
  { type: "join", name: string }
  { type: "node:create", typeId, position, label? }
  { type: "node:update", nodeId, patch }
  { type: "node:config:update", nodeId, config }
  { type: "node:delete", nodeId }
  { type: "edge:create", sourceId, targetId, sourcePort }
  { type: "edge:delete", edgeId }
  { type: "cursor:move", point }
  { type: "chain:run" }
  { type: "chain:stop" }
  { type: "review:approve", nodeId }
  { type: "review:reject", nodeId }
  { type: "plan:node:create", kind, title, body, position, data? }
  { type: "plan:node:update", nodeId, patch }
  { type: "plan:node:delete", nodeId }
  { type: "plan:edge:create", sourceId, targetId, label? }
  { type: "plan:edge:delete", edgeId }
  { type: "chat:message", content, mode, workspaceTab, answers? }
  { type: "chat:apply", operations?, planOperations? }

Server → Clients (broadcast):
  { type: "init", selfId, users, nodes, edges, planNodes, planEdges, nodeTypes }
  { type: "user:joined", user }
  { type: "user:left", userId }
  { type: "node:created", node }
  { type: "node:updated", node }
  { type: "node:deleted", nodeId, edgeIds }
  { type: "edge:created", edge }
  { type: "edge:deleted", edgeId }
  { type: "plan:node:created", node }
  { type: "plan:node:updated", node }
  { type: "plan:node:deleted", nodeId, edgeIds }
  { type: "plan:edge:created", edge }
  { type: "plan:edge:deleted", edgeId }
  { type: "node:status", nodeId, status, output? }
  { type: "chain:started" }
  { type: "chain:complete" }
  { type: "chain:error", message }

Server → requesting client only:
  { type: "chat:response", response, responseMode, questions?, operations?, planOperations? }
  { type: "chat:error", message }
```

## Chat System

`server/ws/handlers/chat.ts`

Modes:
- **Auto** — operations applied immediately after AI responds
- **Plan** — AI asks clarifying questions first, uses answers to shape the Plan workspace or canvas change set, then applies agreed operations
- **Review** — AI sends operations as a preview; user clicks "Apply" to execute

Workspace state is serialized into the prompt on every message: executable canvas nodes/edges plus Plan nodes/edges. AI responds with JSON `{ response, operations?, planOperations?, questions? }`.

Canvas operations and Plan operations both use `tmpId` to reference newly-created nodes within the same batch (two-pass: create nodes first, then edges).

### Chat WS Timing Fix

`useSocket.ts` dispatches `window.CustomEvent("dispatch:chat")` for chat messages instead of trying to pass the event to ChatPanel directly. ChatPanel listens on `window` via `addEventListener("dispatch:chat", ...)`. This avoids the mount-timing race where ChatPanel mounts before the socket connects.

## Rendering

`src/whiteboard/render.ts`

- HiDPI-aware (`devicePixelRatio`)
- Node cards: rounded rect, accent header band, status dot, body preview text, port dots
- `agent` nodes: accent color derived from `config.role` (each role has its own color)
- Header label for `agent` nodes shows the role name (e.g., "INVESTIGATE"), not the type label
- Context edges (source category === `"context"`): amber dashed, enter target at left-center port
- Output ports: bottom center (single) or spaced (multi-port for review/branch)
- Input port: top center (all nodes except start/context)
- Left-side dotted amber circle: context input indicator on ai-step/review/control/tool/memory nodes
- Running nodes: pulsing glow shadow + edge dash animation

`src/whiteboard/renderPlan.ts`

- Separate renderer for the Plan workspace; it does not draw executable ports or statuses
- Plan blocks render title, body preview, kind, and color
- Plan edges connect block bounds and may show a label
- Placement preview and draft edge states are separate from canvas interaction state

## Key Files

```
src/
  types/index.ts                 — BoardNode, BoardEdge, PlanNode, PlanEdge, WorkspaceTab
  whiteboard/
    config/nodeTypes.ts          — NODE_TYPES array (single source of truth for toolbox)
    render.ts                    — Canvas drawing functions
    renderPlan.ts                — Plan workspace drawing functions
    geometry.ts                  — worldToScreen, snapToGrid, hitTest
    hooks/
      useSocket.ts               — WebSocket connection + all WS message handling
      useInteraction.ts          — Mouse/touch event handling (drag, connect, place)
      usePlanInteraction.ts      — Plan block placement, movement, selection, and edges
      usePlanRender.ts           — Plan workspace render loop
    components/
      Whiteboard.tsx             — Top-level canvas orchestrator
      Sidebar.tsx                — Toolbox + properties panel + ChatPanel wrapper
      PlanCanvas.tsx             — Plan workspace canvas and toolbar
      PlanSidebarPanel.tsx       — Plan block toolbox and selected block inspector
      TitleBar.tsx               — Run button, connection status
      ChatPanel.tsx              — Chat UI (modes, message history, plan questions, op preview)

server/
  index.ts                       — Express + static serving
  state/
    store.ts                     — nodes, edges Maps; send/broadcast helpers
    operations.ts                — canvas + Plan graph create/update/delete helpers
  ws/
    server.ts                    — WebSocket server setup
    dispatch.ts                  — Routes all incoming WS message types
    handlers/
      join.ts, node.ts, edge.ts  — CRUD handlers
      chain.ts                   — handleChainRun, handleReviewApprove/Reject
      plan.ts                    — Plan graph CRUD handlers
      chat.ts                    — handleChatMessage, handleChatApply, applyOperations
  execution/
    engine.ts                    — runChain (DFS traversal + per-node execution)
    agentTools.ts                — live agent tools and workspace-safe file/shell helpers
    skills.ts                    — NODE_SKILLS: built-in system prompts per role
    providers/
      openai.ts                  — callOpenAI(model, systemPrompt, userMessage)
      anthropic.ts               — callAnthropic(...)
      google.ts                  — callGoogle(...)
```

## Environment Variables

```
OPENAI_API_KEY=                    # required for agent nodes + chat + branch condition
OPENAI_MAX_COMPLETION_TOKENS=8192  # optional OpenAI Chat Completions cap; uses max_completion_tokens
ANTHROPIC_API_KEY=                 # optional, for agent nodes with provider: anthropic
GOOGLE_API_KEY=                    # optional, for agent nodes with provider: google
BRAVE_API_KEY=                     # optional, for context/agent web search (falls back to DuckDuckGo)
```

## Running Locally

```bash
npm install
npm run dev    # Vite + tsx server concurrently on :5173 / :3001
```

## Known Gaps / Next Steps

1. **Loop/Retry node** — not implemented. Would need cycle detection in the engine.
2. **Context node UX** — left-side port is visually subtle; could be clearer
3. **Chat history** — per-session only; no persistence
4. **Tool/API node** — functional but basic; no auth, no JSON body builder
5. **Memory across runs** — `chainMemory` resets each run; no persistent store
6. **Streaming AI output** — currently awaits full response; streaming would improve UX for long outputs
7. **Plan persistence** — Plan graph is in-memory only, like the canvas
8. **Plan edge editing** — Plan edges can be created/deleted but labels cannot be edited in-place yet
9. **Context resolver reuse** — Plan context blocks are visible to chat as graph state, but the execution context resolver is not yet extracted as an AI-native planning context service
