# DISPATCH.AI — Node V2 Specification

Reference document for AI agents (Codex, Claude, etc.) working on this codebase.
Read this before touching any node, edge, or execution code.

---

## Architecture Overview

DISPATCH.AI is a visual AI orchestration system. Users place nodes on a canvas, wire them
together with edges, and run a chain. The chain executes left-to-right (top-to-bottom in
flow order), calling OpenAI for each SDLC node and passing output downstream.

```
Initialiser ─flow─▶ Investigate ─flow─▶ Plan ─flow─▶ Create ─flow─▶ Materialize
                          ▲                 ▲
                    Context node      Context node
                    (midput edge)     (midput edge)
```

---

## Node Types (`NodeV2Type`)

Defined in `shared/types.ts`. Registry in `shared/nodeRegistry.ts`.

| typeId | Category | Description |
|---|---|---|
| `initialiser` | Infrastructure | Entry point. Defines workspace config. One per canvas. |
| `investigate` | SDLC | Research agent. Web-search persona. |
| `plan` | SDLC | Planning agent. Produces structured phases/tasks. |
| `design` | SDLC | Architecture agent. Produces file layout, contracts. |
| `create` | SDLC | Creation agent. Outputs file-map delimiter format. |
| `evaluate` | SDLC | Evaluation agent. Returns PASS/FAIL + issues. |
| `doc` | SDLC | Documentation agent. Produces README + docs. |
| `materialize` | Infrastructure | Parses file-map from Create, writes files to disk. |
| `context` | Infrastructure | Static text node. Injects content into SDLC nodes via midput. |

### Adding a New Node Type

1. Add the `typeId` string to `NodeV2Type` in `shared/types.ts`
2. Add a `NodeDefinitionV2` entry to `NODE_REGISTRY` in `shared/nodeRegistry.ts`
3. Add a `skills/{typeId}.md` file if it's an SDLC node
4. The engine, store, and operations pick it up automatically — no other changes needed

---

## Node Structure (`NodeV2`)

```typescript
interface NodeV2 {
  id: string;            // e.g. "node_abc123"
  type: NodeV2Type;
  title: string;         // user-editable display name
  x: number;             // world-space position (snapped to 32px grid)
  y: number;
  width: number;         // from NodeDefinitionV2 (fixed per type)
  height: number;
  config: NodeV2Config;  // type-specific settings
  status: "idle" | "running" | "done" | "error";
  output: string | null; // last execution output
  createdBy: string;
  createdAt: number;     // unix ms
  updatedAt: number;
}
```

### Config fields by type

```typescript
interface NodeV2Config {
  workspacePath?: string;  // initialiser — where files are written
  taskPrompt?: string;     // SDLC nodes — user's per-run brief
  content?: string;        // context — static text to inject
}
``` 

---

## Edge Types (`EdgeV2`)

Two kinds of edges connect nodes:

| kind | Direction | Visual | Source port | Target port |
|---|---|---|---|---|
| `flow` | top → bottom | solid bezier | `hasFlowOut` node | `hasFlowIn` node |
| `midput` | left/right | dashed bezier | `hasMidputOut` node | `hasMidputIn` node |

```typescript
interface EdgeV2 {
  id: string;
  sourceId: string;
  targetId: string;
  kind: "flow" | "midput";
  createdBy: string;
  createdAt: number;
}
```

### Port capability flags (on `NodeDefinitionV2`)

```
hasFlowIn     — top port (receives flow from upstream)
hasFlowOut    — bottom port (sends flow to downstream)
hasMidputIn   — left + right ports (receives context from Context nodes)
hasMidputOut  — right port (Context nodes: sends text out)
```

---

## Node Registry (`shared/nodeRegistry.ts`)

Every node type is registered with its visual and behavioral definition:

```typescript
const NODE_REGISTRY: Record<NodeV2Type, NodeDefinitionV2> = {
  investigate: {
    type: "investigate",
    label: "Investigate",
    defaultTitle: "Investigate",
    width: 240,
    height: 104,
    accent: "#2d6a9f",       // accent color for header + ports
    hasFlowIn: true,
    hasFlowOut: true,
    hasMidputIn: true,       // SDLC nodes accept context
    hasMidputOut: false,
    isSDLC: true,
    defaultConfig: { taskPrompt: "" },
  },
  // ... other types
};
```

---

## Execution Engine (`server/features/execution/engine.ts`)

### Chain walk

1. Find the `initialiser` node on the canvas
2. Follow its `flow` edges to get the first node
3. Walk `flow` edges in order: each node's output becomes the next node's `flowInput`

### Per-node execution (SDLC nodes)

```
[System]
{skills/{type}.md content}

[User]
[Context]           ← if any midput Context nodes are connected
{context text 1}
---
{context text 2}

[Chain Input]       ← output from upstream flow node
{previous output}

[Task At Hand]      ← node.config.taskPrompt
{user's brief}
```

### Materialize node

- Input: file-map string with `--- FILE: path ---` delimiters
- Action: writes each file to `{workspacePath}/{path}`, creating directories
- Output: summary of files written with byte counts
- Error: if no delimiters found, throws with preview of what Create actually returned

---

## Skills (`skills/`)

Each SDLC node has a corresponding `skills/{typeId}.md` file.
This is the **system prompt** — the AI persona. It never changes per run.
The user's `taskPrompt` is the per-run brief sent as the user message.

| File | Role |
|---|---|
| `skills/investigate.md` | Research & fact-gathering persona |
| `skills/plan.md` | Senior engineer planning persona |
| `skills/design.md` | Architecture & design persona |
| `skills/create.md` | Code/file creation persona (mandates file-map format) |
| `skills/evaluate.md` | QA/review persona (outputs PASS/FAIL verdict) |
| `skills/doc.md` | Documentation writing persona |

---

## File-Map Delimiter Format

Used by Create node output → parsed by Materialize:

```
--- FILE: src/index.ts ---
import express from "express";
// ... full file content

--- FILE: package.json ---
{
  "name": "my-app"
}
```

Rules:
- Delimiter must be exactly `--- FILE: {relative/path} ---` on its own line
- Content continues until next delimiter or end of string
- Paths are relative to `workspacePath` from Initialiser config

---

## WebSocket Message Protocol

### Client → Server

| type | payload | effect |
|---|---|---|
| `join` | `{ name }` | Register user, receive init payload |
| `node:create` | `{ nodeId, nodeType, position, title, config }` | Create node |
| `node:update` | `{ nodeId, position?, title?, config? }` | Update node |
| `node:delete` | `{ nodeId }` | Delete node + cascade edges |
| `edge:create` | `{ edgeId, sourceId, targetId, kind }` | Create edge |
| `edge:delete` | `{ edgeId }` | Delete edge |
| `chain:run` | `{}` | Start chain execution |
| `chain:stop` | `{}` | Abort running chain |
| `plan:update` | `{ elements }` | Save Excalidraw plan data |

### Server → Client

| type | payload | meaning |
|---|---|---|
| `init` | `{ selfId, users, nodes, edges, planElements }` | Full workspace state on join |
| `node:created` | `{ node }` | Node added (broadcast) |
| `node:updated` | `{ node }` | Node changed (broadcast) |
| `node:deleted` | `{ nodeId }` | Node removed (broadcast) |
| `node:status` | `{ nodeId, status, output }` | Live status during chain run |
| `edge:created` | `{ edge }` | Edge added (broadcast) |
| `edge:deleted` | `{ edgeId }` | Edge removed (broadcast) |
| `chain:started` | `{}` | Chain began executing |
| `chain:complete` | `{}` | Chain finished successfully |
| `chain:stopped` | `{}` | Chain aborted by user |
| `chain:error` | `{ message, nodeId? }` | Chain failed |

---

## State Persistence

Workspace is persisted to `.dispatch/workspace-state.json` after every mutation.
Format: `WorkspaceStateV2 { version: 2, nodes, edges, planElements }`.

Rules enforced on hydration:
- Only one `initialiser` node is loaded (first found wins)
- Edges with dangling references (missing source or target) are dropped
- Nodes of unknown type are dropped

---

## Key Invariants

1. **Only one Initialiser per canvas** — enforced in `createEdge` server-side
2. **No self-loops** — `createEdge` rejects `sourceId === targetId`
3. **No duplicate edges** — same source+target+kind pair is rejected
4. **Port capability checked** — `createEdge` validates that source has `hasFlowOut`/`hasMidputOut` and target has `hasFlowIn`/`hasMidputIn`
5. **Cascade delete** — deleting a node removes all edges connected to it
6. **API key in .env only** — `OPENAI_API_KEY` is read from `process.env`, never stored in node config or workspace state
7. **SDLC list** — `SDLC_NODE_TYPES` in `shared/nodeRegistry.ts` is the authoritative list used by the engine, sidebar, and render layer

---

## Directory Map

```
shared/
  types.ts              NodeV2, EdgeV2, NodeV2Type, WorkspaceStateV2, InteractionState
  nodeRegistry.ts       NODE_REGISTRY, SDLC_NODE_TYPES, getNodeDefinition()

skills/
  investigate.md        System prompt for Investigate node
  plan.md               System prompt for Plan node
  design.md             System prompt for Design node
  create.md             System prompt for Create node (file-map format enforced)
  evaluate.md           System prompt for Evaluate node
  doc.md                System prompt for Doc node

server/features/
  state/
    store.ts            nodes Map, edges Map, persist/hydrate, broadcast/send
    operations.ts       createNode, updateNode, deleteNode, createEdge, deleteEdge
  execution/
    provider.ts         callOpenAI() — reads OPENAI_API_KEY + OPENAI_MODEL from env
    skillLoader.ts      loadSkill(type) — reads + caches skills/{type}.md
    engine.ts           runChain() — walk flow edges, execute nodes, inject midput
  ws/
    dispatch.ts         Message router
    handlers/
      join.ts           Sends init payload with nodes + edges
      node.ts           node:create, node:update, node:delete
      edge.ts           edge:create, edge:delete
      chain.ts          chain:run, chain:stop

src/whiteboard/
  render.ts             Canvas draw: nodes, edges, ports, placement preview
  hooks/
    useSocket.ts        WS connection, nodesRef, edgesRef, terminalLogs, chainRunning
    useInteraction.ts   Pointer events, placement, connection drag, port hit detection
    useRender.ts        RAF-batched render loop
  components/
    Sidebar.tsx         Toolbox, node inspector, Run Chain button
    Terminal.tsx        Dark log panel, toggled from status bar

tests/
  node-v2.test.ts       Node V2 integration tests (8 passing)
```

---

## Environment Variables (`.env`)

```
OPENAI_API_KEY=sk-...        Required — OpenAI API key
OPENAI_MODEL=gpt-4.1-mini   Optional — defaults to gpt-4o if not set
```

Never put API keys in node config, workspace state, or the canvas graph.

---

## Investigate Node — Tool Suite

Investigate uses the OpenAI Responses API with a full tool loop. Tools available:

| Tool | Type | Description |
|---|---|---|
| `web_search_preview` | Built-in | Real-time Bing search, handled automatically by OpenAI |
| `code_interpreter` | Built-in | Python execution sandbox, handles math/data analysis |
| `explore_website(url)` | Custom fn | Fetches full text of a specific URL (strips HTML, 12k cap) |
| `analyze_image(url)` | Custom fn | GPT-4o vision — describes image content in detail |

The engine loops until the model makes no more function calls (max 10 rounds).
Custom tool implementations live in `server/features/execution/provider.ts`.
URL fetching utilities (used by explore_website and Context node) live in `server/features/execution/fetchUtils.ts`.

---

## Context Node — Multiple URLs

`config.content` supports newline-separated entries. Each line is resolved independently:
- If a line is a URL → fetched, HTML stripped, capped at 12k chars
- If a line is plain text → passed through as-is

`resolveMultiContent()` in `fetchUtils.ts` handles the splitting and parallel fetch.

---

## Initialiser Node — Initial Context

`config.content` (textarea in inspector) seeds the first node's `flowInput`.
This lets you give the chain a starting brief without needing a separate Context node.
`config.workspacePath` remains the workspace root for Materialize.
