# MYTHOS_PREVIEW_TEST — Bottlenecks & Latent Errors

Audit of the `canview` / DISPATCH.AI codebase (branch `major-node-switch`) for bugs and
performance bottlenecks that slipped past prior model passes. Findings are ordered by
severity. File/line references point at the active `server/features/**` tree and the React
client under `src/whiteboard/**`; the legacy `server/{state,ws,execution}/**` tree is dead.

Verified state before writing: `npx tsc --noEmit` is clean and `npm test` passes (8/8), so
none of these are caught by the existing gates.

---

## CRITICAL

### C1 — `chain:run` runs against a stale node/edge snapshot; concurrent edits corrupt the run
`server/features/ws/handlers/chain.ts:66-67` copies `nodes`/`edges` into `nodesCopy`/`edgesCopy`
once at launch, but the maps hold the **same node object references** (`new Map(nodes)` is a
shallow copy). During a run, `updateNodeStatus` in `operations.ts:201` does
`{ ...node, status }` and re-`set`s the **live** `nodes` map — so the copy and the live map
diverge for status, yet still share `config` object references. Any `node:config:update` or
`node:update` that lands mid-run mutates state the engine is actively reading. There is no lock
between the WebSocket edit handlers and an in-flight `runChain`. Result: non-deterministic runs,
and a config edit during execution can change a node's behavior after it has already partially
executed.

### C2 — `shell_exec` and `shell-exec` allow arbitrary command execution with no allow-list
`server/features/execution/tools/agentTools.ts:409-433` and the `shell-exec` node in
`engine.ts:901-932` pass model- or user-supplied strings straight into
`child_process.exec(command, { cwd })`. `exec` runs through `/bin/sh`, so `;`, `&&`, backticks,
and `$()` all work. The only guard is the `requestToolApproval` callback, and that is **only
wired for the agent-tool path** (`RISKY_TOOLS` in `agentTools.ts:67`). The `shell-exec` *node*
type in the engine has **no approval gate at all** — a chat-generated workflow containing a
`shell-exec` node executes whatever command string the model wrote, against the server's real
working directory, the moment the chain runs. This is a remote-code-execution surface on any
multi-user deployment (the server binds `0.0.0.0`, `server/index.ts:40`).

### C3 — Workspace path sandbox is bypassable; `resolveWorkspacePath` silently re-homes escapes
`agentTools.ts:125-137`. When a path resolves **outside** `WORKSPACE_ROOT`, the function does
not reject it — it strips the leading slash/drive and re-resolves *relative* to the root
(`normalizeWorkspaceRelativePath`). That is the intended "be forgiving" behavior, but combined
with `read_file`/`write_file` it means the agent cannot be reliably confined: a symlink inside
the workspace pointing outward is followed (no `realpath` check), and an absolute path like
`/etc/passwd` becomes `WORKSPACE_ROOT/etc/passwd` rather than being denied — which masks an
attempted escape instead of surfacing it. There is no audit/error for "path was outside
workspace," so the difference between a legitimate relative read and a thwarted traversal is
invisible.

---

## HIGH

### H1 — Per-run review/approval resolvers are keyed globally; collide across the only allowed run
`chain.ts:23` `reviewResolvers` is keyed by `nodeId`, and `approvalResolvers` (store.ts:55) is a
module-global map. `handleChainRun` blocks a second concurrent run (`runningChains.get("main")`),
so today only one chain runs — but `handleReviewApprove/Reject` (`chain.ts:121-143`) resolve by
`nodeId` with **no `runId` check**. A stale `review:approve` message (e.g. user double-clicks,
or a message arrives after `chain:stop` already rejected everything in `handleChainStop:173`)
will resolve a resolver that a *later* run installed for the same node id, silently approving a
gate the user never saw. The promise plumbing has no run-scoping.

### H2 — `requestToolApproval` attributes the approval to the wrong node under parallel fan-out
`chain.ts:92-100`: the node id for a tool-approval request is discovered with
`Array.from(nodes.values()).find(n => n.status === "running")`. The engine fans out with
`Promise.all` (`engine.ts:1037`), so multiple agent nodes can be `running` simultaneously. The
"find first running node" heuristic therefore tags the approval prompt — and the resulting
trace/UI highlight (`pendingApprovalNodeIdsRef`) — onto an arbitrary running node, not the one
that actually requested the tool. With parallel branches both calling `shell_exec`, the user
can approve the wrong node's command.

### H3 — Cycle in the workflow graph stalls/!completes silently
`engine.ts:683` `executeNode` guards re-entry with `visited.add(nodeId)`, which prevents infinite
recursion, but the consequence is unhandled: an edge that points back to an already-visited node
is simply dropped (`if (visited.has(nodeId)) return;`). A loop-back workflow (common for
retry/branch patterns — "if evaluate fails, go back to create") will **never re-execute** the
upstream node. There is no diagnostic emitted; the chain just completes with the loop edge
having had no effect, which looks like a silent logic bug to the user. Branch/Review ports invite
exactly this topology.

### H4 — `evaluateCondition` shorthand is dead code; Branch nodes ignore it entirely
`engine.ts:358-417` defines a rich `evaluateCondition` (handles `success`, `exit:0`,
`output.includes(...)`, length comparisons, etc.) — but it is **never called anywhere** in the
active tree (only the legacy `server/execution/engine.ts` references it). The live Branch node
(`engine.ts:867-876`) instead always makes a full LLM round-trip to evaluate the condition, even
for a trivial `exit:0` check. That is both a latent-bug (the documented shorthand silently does
nothing) and a performance/cost bottleneck (an API call + token spend for conditions that are
pure string checks). `buildAgentToolInstructions` (imported at `engine.ts:11`) is likewise
imported but unused.

### H5 — `persistWorkspaceState()` does a full synchronous JSON serialize + fsync on every mutation
`operations.ts` calls `persistWorkspaceState()` on **every** node move, config tweak, edge
create/delete, plan edit, and memory write. Each call (`store.ts:151-160`) synchronously
`JSON.stringify`s the *entire* workspace (all nodes, edges, plan, last 25 ledgers, last 50
artifacts — ledgers contain full fact/output text) and does a blocking `writeFileSync` +
`renameSync` on the main thread. During a node drag, `moveNode` (`useInteraction.ts:363-379`)
fires `node:update` on every pointer-move frame, so the server serializes and rewrites the whole
state file dozens of times per second per dragging user. This is the dominant server-side
bottleneck; it should be debounced/coalesced and run off the hot path.

---

## MEDIUM

### M1 — Spread-context BFS is O(nodes × edges) and re-scans all edges per node
`engine.ts:658-677`: the downstream context-propagation walk calls
`graph.get(nodeId)` per node but the initial `contextFor` build (`engine.ts:650-656`) loops over
**all edges for every context payload**, and the BFS pushes targets without deduping before the
`seen` check, so wide graphs re-enqueue heavily. Fine for tiny demos, but it is quadratic and
sits in the run-start critical path before any model call.

### M2 — Trace ledger fact is recorded with full untruncated tool output
`engine.ts:758-765` adds a ledger fact with `content: record.result` — the **entire** tool
result (web page text, file contents, shell output up to 16 KB). `buildLedgerSummary` later
slices facts to 420 chars for the prompt, but the raw ledger keeps everything, the last 25
ledgers are persisted to disk on every mutation (see H5), and `serializeRunHistory` ships them
to every joining client. Memory and payload grow with tool verbosity unbounded per run.

### M3 — Client trace buffer is rebuilt by full array copy on every single trace event
`useSocket.ts:227`: each `node:trace` message does
`[...nodeRunTraceEventsRef.current.slice(-499), trace]` and bumps `traceVersion`, and
`Whiteboard.tsx:148-151` then does another full `[...ref]` copy into a memo on every
`traceVersion` change. During an active run the server can emit many traces per node; this is
O(n) allocation per event and forces a canvas re-render each time. A ring buffer + batched
version bump would remove the per-event churn.

### M4 — `node:status` and `node:output` are broadcast as two separate messages for one transition
`chain.ts:74-83`: each status change broadcasts a `node:status` *and*, when output is present, a
second `node:output` message carrying the same `output.slice` already attached to the status. The
client handles both (`useSocket.ts:165-187`), each bumping `graphVersion` and re-rendering. Output
is sent twice over the wire and triggers two renders per node completion.

### M5 — `fetch` in URL context and `tool` nodes has no timeout or size guard
`engine.ts:442` (context `url` source) and `engine.ts:883` (HTTP `tool` node) call bare `fetch`
with no `AbortController`/timeout, unlike the agent-tool `fetchWithTimeout` path. A slow or
hanging endpoint stalls the whole chain indefinitely (the context pre-pass uses `Promise.all`,
so one hung URL blocks every context node). The `tool` node also `JSON.parse`s
`node.config.headers` (`engine.ts:885`) with no try/catch — malformed headers throw and the
error is only caught by the generic node handler, surfacing as a confusing "Unexpected token"
rather than "invalid headers".

---

## LOW / CORRECTNESS NITS

### L1 — `chain:stop` doesn't actually interrupt the running engine
`handleChainStop` (`chain.ts:169`) deletes the `runningChains` flag and resets node *status*, but
the `runChain` promise keeps executing (in-flight `await callAIWithTools`, `exec`, `fetch` all
continue). The user sees nodes reset to idle while the model calls and shell commands keep
running to completion in the background, then `appendRunHistory` still fires. There is no
`AbortSignal` threaded into the engine.

### L2 — Stop during the context pre-pass leaves the run half-initialized
`runChain` resolves context nodes (`engine.ts:600-616`) before `executeNode` starts. A stop
issued in that window can't be observed (no abort), and the chain proceeds into execution anyway.

### L3 — `handleChatApply` applies operations with **no plan-mode/preview re-validation by run state**
`chat.ts:416-427` trusts client-supplied `operations`/`planOperations` and runs them through
`normalizeForApply` only. Since the snapshot used for normalization is the *current* server
state, an "apply" of a stale preview (generated against an older graph) can create edges to nodes
that were since deleted — `createEdge` returns null for those, so they vanish silently, producing
a partially-applied change set with no warning surfaced to the user.

### L4 — `safeJsonArgs` swallows malformed tool-call arguments into `{}`
`providers/openai.ts:29-38`: if the model emits invalid JSON for tool arguments, the args become
an empty object and the tool runs with defaults (e.g. `shell_exec` with no command throws, but
`read_file` with empty path resolves to the workspace root and dumps a directory listing). A
parse failure should be surfaced back to the model as a tool error, not silently coerced.

### L5 — `findStartNode` picks an arbitrary Start node when several exist
`engine.ts:354` uses `Array.from(...).find(typeId === "start")`. The chat system prompt says
never to create a second Start, but nothing in `createNodeFromPayload` enforces uniqueness, so a
user can place two Start nodes; the engine then silently runs from whichever the Map iteration
happens to yield first.

### L6 — Duplicate divergent `ServerNode`/`ServerEdge` type definitions
`engine.ts:39-60` and `store.ts:23-46` each declare their own `ServerNode`/`ServerEdge`
interfaces. They currently agree, but there is no shared source of truth, so a field added to one
(e.g. a new config shape or status value) won't be type-checked against the other — a latent
drift bug the compiler can't catch.

### L7 — Color assignment never recycles; `colorIndex` grows unbounded
`store.ts:74-75` / `server.ts:21` increment `colorIndex` on every connection and never decrement
on disconnect. Functionally fine (it's `% userColors.length`), but two users who join after
churn can collide on the same color while a small palette is "available," and the counter is a
monotonic int kept for process lifetime.

---

## Summary of the highest-leverage fixes
1. **C2/C1**: gate the `shell-exec` *node* behind the same approval callback as the agent tool,
   and deep-snapshot (or lock) graph state for the duration of a run.
2. **H5/M2**: debounce `persistWorkspaceState`, and cap stored ledger fact content.
3. **H4**: wire `evaluateCondition` into the Branch node so deterministic conditions skip the LLM.
4. **L1**: thread an `AbortSignal` through `runChain` so `chain:stop` actually halts work.
