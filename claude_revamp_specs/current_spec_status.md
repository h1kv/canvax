# DISPATCH.AI — Current Spec Status

Last updated: 2026-06-10

---

## Phase 1 — Node V2 Canvas (COMPLETE)

All Phase 1 work is shipped on branch `major-node-switch`.

### Core canvas
- [x] 9 node types: initialiser, investigate, plan, design, create, evaluate, doc, materialize, context
- [x] EdgeV2 with `flow` (solid bezier) and `midput` (dashed bezier) kinds
- [x] Port capability flags per node: hasFlowIn, hasFlowOut, hasMidputIn, hasMidputOut
- [x] Port hit detection + connection drag on canvas
- [x] Node placement preview, snap-to-grid
- [x] Persistent workspace state (`.dispatch/workspace-state.json`, atomic write)
- [x] Multi-user cursors via WebSocket broadcast

### Chain execution
- [x] Linear flow-edge walk from Initialiser outward
- [x] Two-layer prompt: skill.md (system) + taskPrompt (per-run user brief)
- [x] Midput context injection: [Context] + [Chain Input] + [Task At Hand]
- [x] Context node auto-fetches URLs (strips HTML, 12k cap, 10s timeout)
- [x] Context node supports multiple URLs (newline-separated, fetched in parallel)
- [x] Initialiser `content` field seeds first node's flow input
- [x] Run Chain resets all node statuses to idle before executing
- [x] AbortController for chain stop

### Investigate node tools
- [x] `web_search_preview` — built-in Bing search via Responses API
- [x] `code_interpreter` — OpenAI Python sandbox (math, data analysis)
- [x] `explore_website(url)` — custom fn: fetch + strip + cap
- [x] `analyze_image(url)` — custom fn: GPT-4o vision description
- [x] Tool loop: up to 10 rounds until model stops calling tools

### UI / sidebar
- [x] VSCode-style layout: TitleBar + ActivityBar + Sidebar + Canvas + StatusBar
- [x] Sidebar toolbox: Infrastructure section + SDLC section
- [x] Inspector: title, workspace path, initial context, task prompt, status pill
- [x] 4-tab bottom panel: Terminal | Problems | Output | Files
- [x] Terminal: chronological chain/node log entries with level prefixes
- [x] Problems tab: clickable error list per node, jumps to node on click
- [x] Output tab: full output for selected node, Copy button
- [x] Files tab: Materialize write plan with per-file action badges + diff expand
- [x] Status bar: mode, chain running indicator, error count, panel toggle, zoom

### Skills system
- [x] skills/investigate.md, plan.md, design.md, create.md, evaluate.md, doc.md
- [x] loadSkill() caches skill files per type

---

## Execution Feature 1A — Safe Writes, Retry, Review (COMPLETE)

Implemented from `exec_feature_1a.md`.

### Safe Materialize writes
- [x] Path validation: rejects absolute paths, `~/` paths, `../` traversal
- [x] Dangerous file blocklist: `.env`, `.env.*`, `.ssh/`, `.git/`, `.pem`, `.key`, private key patterns
- [x] Secret detection in content: private keys, OpenAI/AWS/GitHub tokens, `api_key=...` patterns — warns but writes
- [x] 1MB per-file size limit
- [x] Atomic writes: `absPath.dispatch-tmp` → `rename` (safe on same partition)
- [x] Diff preview for existing files being modified (simple line-by-line, 30-line cap)
- [x] Files tab in bottom panel: shows plan with create/modify/skip badges, diff expand, warnings
- [x] Terminal logs every parse / create / modify / skip / write event

### Retry from failed node
- [x] `chain:retry { fromNodeId }` WS message
- [x] `runChainFrom(fromNodeId)` in engine: uses upstream node's cached `.output` as seed
- [x] Resets downstream nodes to idle before executing
- [x] "↺ Retry from here" button in inspector (visible on done/error nodes)

### Review node
- [x] New node type: `review` (amber accent, flow in, approve out, reject out)
- [x] Two distinct output ports:
  - Approve (green, bottom-left) — solid green bezier
  - Reject (red, bottom-right) — dashed red bezier
- [x] Chain pauses at Review node, emits `review:requested` to all clients
- [x] Bottom panel auto-switches to Review tab
- [x] Three actions: Approve (pass through), Reject (follow reject edge), Request changes (notes injected into flow)
- [x] If rejected with no reject edge wired → chain errors with clear message
- [x] `review:respond { reviewId, action, notes? }` WS message
- [x] Status bar shows "⏸ Awaiting review" while paused
- [x] Dynamic engine walk (BFS-based): supports branching across approve + reject paths

---

## Phase 2 — Chat Graph Builder (NOT STARTED)

Describe a workflow in the chat panel → system auto-creates and wires nodes.

Blocked on: nothing. Ready to start when prioritised.

---

## Deferred / Known Gaps

- Model selection per node (currently global via `OPENAI_MODEL` env var)
- Parallel chain branches (engine is single-path today)
- Shell execution node (explicitly out of scope for 1A)
- Deployment support (explicitly out of scope for 1A)
- Lockfile protection in Materialize (noted in spec as "explicitly allowed later")
- QoL polish (user deferred)
- Full unified diff (current diff is line-by-line, not LCS-based)
- Problems tab: click-to-select-node wired (implemented); keyboard nav not added

---

## Environment Variables

```
OPENAI_API_KEY=sk-...     Required
OPENAI_MODEL=gpt-4o       Optional, defaults to gpt-4o
```

API keys live in `.env` only — never in node config, canvas state, or workspace.

---

## Key Files

```
shared/types.ts             NodeV2, EdgeV2, EdgeV2Kind (flow|midput|reject), NodeDefinitionV2
shared/nodeRegistry.ts      NODE_REGISTRY, SDLC_NODE_TYPES, getNodeDefinition()
node_spec.md               Full handoff doc for Codex/Claude (node types, engine, WS protocol)
claude_revamp_specs/
  CONCEPT_PLAN.md           Original concept
  IMPLEMENTATION_SPEC.md    Detailed implementation spec
  exec_feature_1a.md        Execution Feature 1A spec (safe writes, retry, review)
  current_spec_status.md    This file

server/features/
  state/store.ts            nodes + edges Maps, persist/hydrate
  state/operations.ts       createNode, updateNode, deleteNode, createEdge (validates reject kind), deleteEdge
  state/reviewStore.ts      Pending review Promise map (waitForReview / resolveReview)
  execution/fetchUtils.ts   isUrl, stripHtml, resolveContent, resolveMultiContent
  execution/materializeSafe.ts  buildWritePlan, safelyMaterialize (path validation, atomic, secrets, diff)
  execution/engine.ts       runChain, runChainFrom — dynamic BFS walk with Review branching
  execution/provider.ts     callOpenAI, callOpenAIWithTools (tool loop, explore_website, analyze_image)
  execution/skillLoader.ts  loadSkill()
  ws/handlers/chain.ts      chain:run, chain:retry, chain:stop
  ws/handlers/review.ts     review:respond

src/whiteboard/
  render.ts                 Canvas draw: nodes, edges, ports (incl. approve/reject), reject bezier
  hooks/useSocket.ts        WS client: nodeErrors, materializePlan, reviewRequest state
  hooks/useInteraction.ts   Port hit detection (incl. rejectOut), selectNode()
  components/Sidebar.tsx    Toolbox, inspector, retry button
  components/BottomPanel.tsx 4-tab panel: Terminal, Problems, Output, Files, Review
```
