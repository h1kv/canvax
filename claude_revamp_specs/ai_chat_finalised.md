# DISPATCH.AI — Chat Orchestrator Handoff
## Feature 2A-1B — Finalised Implementation

Branch: `major-node-switch`

---

## What Was Built

The chat panel is now a full workflow copilot. It can:

1. **Create workflows** from natural language — generates typed op batches, validates them, shows a confirm card before applying
2. **Explain the graph** — answers what each node does, what flows where, what's unused
3. **Validate before run** — all 7 error/warn checks run on every chat turn; issues shown in the context the model receives
4. **Repair graph problems** — propose_operations can add missing edges, fix context-via-flow, insert missing nodes
5. **Edit selected nodes** — knows which node is selected, can rewrite taskPrompt, rename, etc.
6. **Run chain commands** — "run the chain", "stop it", "retry from Create" → execute_command → command card → one click
7. **Debug failures** — node error states and terminal log summary injected into model context

---

## Architecture

### Flow of a chat message

```
Client: chat:message { content, workspaceTab, selectedNodeId }
  ↓
Server: handleChatMessage
  ├── serializeGraph(nodes, edges) → compact text block
  ├── validateGraph(nodes, edges) → issue list injected into user turn
  ├── callChatModel(messages, onChunk) → streaming OpenAI Chat Completions
  │     └── streams chat:chunk events to client as tokens arrive
  ├── if toolName === "propose_operations":
  │     ├── simulateOperations(ops) → validates port compatibility, tempId refs
  │     ├── validateGraph(simulated) → catches post-op errors
  │     └── sends chat:done { text, pendingOps, pendingSummary } OR chat:done { text, error }
  ├── if toolName === "execute_command":
  │     └── sends chat:done { text, command, commandNodeId }
  └── else: sends chat:done { text }

Client: ChatPanel receives via dispatch:chat window event
  ├── chat:chunk → appends to streaming bubble (live typing effect)
  ├── chat:done → finalises message; shows OpCard or CommandBadge if needed
  ├── chat:applied → marks ops as applied (green badge)
  └── chat:error → shows inline error message

User clicks Apply → chat:apply { operations }
  ↓
Server: handleChatApply
  ├── computeLayoutForBatch(existingNodes, newNodes, newEdges) → positions
  ├── for each op in order:
  │     create_node → createNodeFromPayload → broadcast node:created
  │     update_node → updateNode → broadcast node:updated
  │     delete_node → collect related edges, broadcast edge:deleted × N, deleteNode, broadcast node:deleted
  │     create_edge → createEdge (resolving tempIds) → broadcast edge:created
  │     delete_edge → deleteEdge → broadcast edge:deleted
  └── sends chat:applied to requesting client only
```

---

## File Map

```
server/features/chat/
  graphSerializer.ts      Serialize nodes+edges to text the model can reason about
  graphValidator.ts       7 validation rules returning ValidationIssue[]
  graphLayout.ts          Auto-position new nodes (chain vertical, context nodes left)
  graphSimulator.ts       Dry-run ops against in-memory copies; ChatGraphOperation type
  chatProvider.ts         Streaming OpenAI call + CHAT_SYSTEM_PROMPT + tool definitions

server/features/ws/handlers/chat.ts    handleChatMessage + handleChatApply (full impl)
server/features/ws/dispatch.ts         chat:apply → handleChatApply (added)

src/whiteboard/hooks/useSocket.ts      Added: chat:chunk, chat:done, chat:applied, chat:error → dispatch:chat
src/whiteboard/components/ChatPanel.tsx    Full rewrite: streaming, OpCard, CommandBadge, ErrorInline
src/whiteboard/components/Sidebar.tsx     Passes selectedNodeId to ChatPanel
src/styles.css                            New: .vsc-chat-ops-card, .vsc-chat-cmd-card, .vsc-chat-error-inline, streaming cursor
```

---

## WebSocket Protocol

### Client → Server

| Message | Fields | Description |
|---|---|---|
| `chat:message` | `content: string`, `workspaceTab`, `selectedNodeId: string \| null` | User sends a message |
| `chat:apply` | `operations: ChatGraphOperation[]` | User confirms pending ops |

### Server → Client

| Message | Fields | Description |
|---|---|---|
| `chat:chunk` | `text: string` | Streaming token chunk |
| `chat:done` | `text: string`, `pendingOps?`, `pendingSummary?`, `command?`, `commandNodeId?`, `error?` | Model finished |
| `chat:applied` | — | Ops successfully applied (sent only to requesting client) |
| `chat:error` | `message: string` | Something failed |

`chat:done` is mutually exclusive: it carries either `pendingOps + pendingSummary`, `command + commandNodeId`, `error`, or just `text`.

---

## ChatGraphOperation Type

Defined in `server/features/chat/graphSimulator.ts`:

```typescript
type ChatGraphOperation =
  | { op: "create_node"; tempId: string; nodeType: NodeV2Type; position?: { x: number; y: number }; title?: string; config?: Partial<NodeV2Config> }
  | { op: "update_node"; nodeId: string; title?: string; config?: Partial<NodeV2Config> }
  | { op: "delete_node"; nodeId: string }
  | { op: "create_edge"; tempId: string; sourceId: string; targetId: string; kind: EdgeV2Kind }
  | { op: "delete_edge"; edgeId: string };
```

**tempId**: model-invented string for cross-referencing within a batch (e.g. `"init"`, `"node-1"`, `"e-1"`). `sourceId` and `targetId` on `create_edge` can be either a `tempId` from the same batch or a real existing nodeId from the graph.

**Position**: model does NOT specify positions. `computeLayoutForBatch` computes them server-side. Model omits position entirely.

---

## Model Tools

Both tools are defined in `chatProvider.ts` and passed to `client.chat.completions.create`.

### `propose_operations`

```
summary: string           — shown to user in confirm card
operations: Operation[]   — typed op batch (see ChatGraphOperation above)
```

Server validates the batch through two gates:
1. `simulateOperations` — checks port capabilities (hasFlowOut/hasFlowIn/hasMidputOut/hasMidputIn/hasRejectOut), resolves tempIds, catches unknown node types
2. `validateGraph(simulatedResult)` — checks the post-op graph for blocking errors (missing init, context via flow, cycles, etc.)

If either fails → `chat:done { error }`. Client shows inline error card instead of confirm card.

### `execute_command`

```
command: "run_chain" | "stop_chain" | "retry_from_node"
nodeId?: string   — required for retry_from_node
```

Server sends `chat:done { text, command, commandNodeId }`. Client shows CommandBadge with an "Execute" button. User clicks → client sends the corresponding WS message (`chain:run`, `chain:stop`, `chain:retry { fromNodeId }`).

Commands are NOT auto-executed. User must click Execute. This is intentional — prevents accidental chain runs.

---

## Graph Serialization Format

Injected into the user message on every turn (fresh state, not stored in history):

```
## Current Graph

NODES (4):
  [Initialiser] "My Project" | id:node_abc workspace:./src
  [Investigate] "Research" [done] | id:node_def task:"Find all React hooks usage in the codebase"
  [Create] "Write Code" [error] | id:node_ghi task:"Implement the feature" error:API key invalid
  [Context] "Repo Docs" | id:node_jkl content:"https://example.com/docs"

EDGES (3):
  "My Project" --[flow]--> "Research"
  "Research" --[flow]--> "Write Code"
  "Repo Docs" --[midput]--> "Research"

GRAPH ISSUES:
  [error] "Write Code" (create) has no flow input — won't run.
  [warn] Initialiser has no workspace path.
```

Graph dump is NOT stored in conversation history. Only `{ role: "user", content: USER_WORDS }` and `{ role: "assistant", content: RESPONSE_TEXT }` are stored. This keeps history compact and avoids the model reasoning over stale graph state from old turns.

---

## Layout Algorithm

`computeLayoutForBatch` in `graphLayout.ts`:

1. **Anchor point**: find the bottommost point of all existing nodes. New chain starts below it (+ 40px gap). If graph is empty, defaults to `{x: 400, y: 200}`.
2. **Chain order**: topological sort of new non-context nodes by following flow edges. Nodes with no new-node predecessor are chain roots. Stragglers (no edges) appended at end.
3. **Chain positions**: assign vertically, `y += nodeHeight + 40px` per node. All snapped to 32px grid.
4. **Context node positions**: placed 288px to the left of their midput target, Y-centered at the target's midpoint. Fallback: above chain start if no target found.

The model never sees or produces position values. Every `create_node` op with a missing position gets one assigned by this function.

---

## Graph Validator Rules

`validateGraph` in `graphValidator.ts` returns `ValidationIssue[]` with `kind: "error" | "warn"`:

| # | Kind | Condition |
|---|---|---|
| 1 | error | No initialiser node |
| 2 | error | Multiple initialiser nodes |
| 3 | error | Initialiser has no flow output edge |
| 4 | warn | Initialiser has no workspacePath |
| 5 | warn | SDLC node has no flow input (orphan) |
| 6 | warn | SDLC node has no taskPrompt |
| 7 | error | Context node connected via flow edge (must be midput) |
| 8 | warn | Materialize node has no flow input |
| 9 | error | Cycle detected in flow+reject graph (DFS) |

Errors only block `propose_operations` when they appear in the **post-op simulated graph**. Pre-op issues are shown to the model as context but don't block it from proposing fixes.

---

## Conversation History

Stored per WebSocket connection in a `WeakMap<WebSocket, ChatCompletionMessageParam[]>`.

- Max 40 messages (20 pairs). Oldest 2 dropped when limit exceeded.
- Stored content: plain user text + assistant response text. NOT the graph dump.
- History is passed as prior turns before the current user message (which includes the full graph dump).
- History is cleared when the WebSocket connection closes (WeakMap GC).

---

## System Prompt (summary)

Full prompt in `chatProvider.ts`. Key sections:

- **Node type descriptions** with what each node does and when to use it
- **Edge type descriptions** (flow / midput / reject)
- **Strict rules**: context→midput only, one initialiser, SDLC nodes need taskPrompt, always start with initialiser, fill taskPrompts with specific content based on user intent
- **When to use tools** vs. when to reply in text
- **Operation rules**: use tempId, don't include position, be specific with taskPrompts
- **Style**: direct, no filler

---

## Conversation History Across Reconnects

Currently: history is **per WebSocket connection only**. If the user refreshes the page, history is gone. This is intentional for now — the graph state is persisted (`.dispatch/workspace-state.json`) but chat history is ephemeral.

If persistent history is needed: serialize history to `.dispatch/chat-history.json` keyed by userId. Not implemented.

---

## Known Gaps / Future Work

| Gap | Notes |
|---|---|
| Model sometimes generates edgeId in delete_edge for edges it doesn't know | Edge IDs are not exposed in graph serialization. Avoid using delete_edge for now — wrap in a note in system prompt. |
| No streaming for ops validation error | If model generates bad ops, the `chat:done { error }` is sent but text was already streamed. Client shows error card below the streamed text. Works but slightly awkward. |
| Retry-from-node command needs real nodeId | Model reads this from the graph context serialization. Works as long as node exists and was included in the dump. |
| No multimodal input | Users can't paste images/files into chat. Investigate node handles images via URLs only. |
| No context injection from chat | Chat can't create a context node pre-filled from the current chat conversation. Could be useful: "use this text as context" → create_node(context, content=...). Already supported by ops but no UX shortcut. |
| History not persisted across page reload | By design for now. |

---

## Integration Notes for Codex

- The existing `node:created`, `node:updated`, `node:deleted`, `edge:created`, `edge:deleted` broadcast messages from `handleChatApply` are identical to what the normal node/edge handlers emit. `useSocket.ts` already handles all of them — no client changes needed for graph sync.
- `handleChatApply` is synchronous (no async ops). It applies in order. If a `create_node` fails (e.g. second initialiser), that op is silently skipped but subsequent ops continue. This matches the simulator's behaviour.
- The `chat:applied` message is sent only to the requesting `ws` (via `send`), not broadcast. Other connected clients see the graph changes via the broadcast `node:created` etc. messages.
- The `computeLayoutForBatch` function has no side effects — safe to call multiple times. It reads `existingNodes` but does not mutate it.
- `CHAT_SYSTEM_PROMPT` is exported from `chatProvider.ts` for easy patching without touching the function logic.
