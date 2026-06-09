# CODEX_CONTEXTIFY — feat-2v Session Handoff

Date: 2026-06-09  
Branch: `feat-2v` (branched from `main` at `ff8b92c`)  
Session: Claude Sonnet 4.6 via DISPATCH.AI v2 refactor

---

## Active / Known Errors (as of 2026-06-09)

### ERROR 1 — Responses API `fetch failed` after ~77s ❌ UNFIXED

**Symptom:** Investigate node trace shows:
```
model    → Model call: openai/gpt-5.5 (Responses API)
tool-call → Calling web_search
[77 seconds pass]
error    → fetch failed
```

**Root cause (two compounding issues):**

1. **Wrong model for Responses API.** `gpt-5.5` is the hardcoded default in `server/features/execution/engine.ts` (line ~339: `firstNonBlank(startNode.config.defaultModel, "gpt-5.5")`). The OpenAI Responses API `/v1/responses` with the `web_search_preview` built-in tool only works with specific models: `gpt-4o`, `gpt-4o-mini`, `gpt-4o-search-preview`, `gpt-4o-mini-search-preview`. Sending `gpt-5.5` to that endpoint causes the request to hang indefinitely on OpenAI's side.

2. **No timeout on `callOpenAIResponses`.** The `fetch()` call in `server/features/execution/providers/openai.ts` has no `AbortController` / signal. When the server-side request hangs, Node.js waits until the OS-level TCP timeout (~75-90s) before throwing.

3. **Error cause is hidden.** The `catch` in the engine does not log `err.cause`, so the trace only shows `"fetch failed"` with no underlying network error detail.

**Fix needed (3 changes):**

- `server/features/execution/engine.ts` → change default model from `"gpt-5.5"` to `"gpt-4o"` (or read from `OPENAI_SEARCH_MODEL` env var for the Responses API branch specifically)
- `server/features/execution/providers/openai.ts` → add `AbortController` with 90s timeout to `callOpenAIResponses`, and rethrow with `cause` exposed: `throw new Error(\`fetch failed: \${(err as NodeJS.ErrnoException).code ?? "unknown"}\`, { cause: err })`
- `server/features/execution/engine.ts` → in the Responses API catch block, log `err.cause` to the trace so the real error is visible

---

### ERROR 2 — Run button jammed against "1 online" (no gap) ⚠️ PARTIALLY FIXED

**Symptom:** Run button and online indicator have no visual spacing between them; both stuck to right edge of titlebar.

**Root cause:** `.vsc-titlebar-meta` had `margin-left: auto` but `.vsc-titlebar-center` has `flex: 1` — the flex-grow item absorbs all free space first, leaving `margin-left: auto` with 0px to distribute. No gap between `.vsc-titlebar-actions` and `.vsc-titlebar-meta`.

**Fix applied (`src/styles.css`):**
- `.vsc-titlebar-actions` → added `margin-left: 12px`
- `.vsc-titlebar-meta` → changed `margin-left: auto` to `margin-left: 10px`

**Status:** CSS fix committed. Needs visual verification in browser.

---

### ERROR 3 — TitleBar squished with 3 tabs ✅ FIXED

**Symptom:** Canvas | Plan | Skills tabs + brand + Run button + meta all cramped in 40px bar.

**Root cause:** Phase 6 added a third tab (Skills) without increasing titlebar height.

**Fix applied (`src/styles.css`):** height `40px → 44px`, tab padding `0 14px → 0 13px`, brand font-size `13px → 12px`.

---

### ERROR 4 — Investigate node producing generic template output ✅ FIXED

**Symptom:** Investigate node returned a boilerplate markdown template with no real research, citing no real URLs.

**Root cause:** Phase 3 (folder restructure) ran concurrently with Phase 1+2 (Responses API) in separate git worktrees. Phase 3 copied the OLD engine code into `server/features/` before Phase 1+2 changes existed. After merging, the running server used `server/features/execution/engine.ts` which had neither the Responses API path nor the file-based skill loader — it fell back to DuckDuckGo (`executeAgentTool('web_search')`) which returned `"No instant answers found for: ..."`.

**Fix applied:**
- `server/features/execution/providers/openai.ts` → added `callOpenAIResponses()`
- `server/features/skills/loader.ts` → rewrote to load from `skills/*.md` files on disk
- `server/features/execution/engine.ts` → added Responses API routing branch + `getSkillPrompt()` call

---

## What This Session Did

Seven phases of work, all merged into `feat-2v`. Build passes (`npm run build`). TypeScript clean (`tsc --noEmit`).

---

## Phase 1+2 — OpenAI Responses API + Skill File System

**Commit:** `2f39f5a` / merge `4c133c1`

### New files
- `skills/_base.md` — injected before every role skill
- `skills/investigate.md` — mandates 5-step search→fetch→synthesize protocol
- `skills/plan.md`, `skills/design.md`, `skills/create.md`, `skills/evaluate.md`, `skills/document.md`
- `skills/test.md`, `skills/debug.md`, `skills/refactor.md`, `skills/deploy.md`
- `server/execution/skillLoader.ts` — reads `.md` files from `skills/` at repo root, caches, returns `base + role`

### Modified files
- `server/execution/providers/openai.ts` — added `callOpenAIResponses()` using `POST /v1/responses` with `web_search_preview` tool
- `server/execution/engine.ts` — routes to `callOpenAIResponses` when `tools.includes('web_search') && provider === 'openai'`; uses `getSkillPrompt(role)` from skillLoader instead of inline `NODE_SKILLS`
- `server/execution/skills.ts` — added `getFallbackSkill()` export for skillLoader fallback

### What could break
- `callOpenAIResponses` uses the `/v1/responses` endpoint. If the model (`gpt-5.5`) does not support Responses API, it will throw. Fallback: switch to a supported model like `gpt-4o-search-preview`.
- `skillLoader.ts` reads from `process.cwd() + '/skills/'`. If the server is started from a non-root directory, skill files won't be found and it falls back to `getFallbackSkill()`.

---

## Phase 3 — Feature-Based Folder Structure + `/shared/types.ts`

**Commit:** `8f9dff2` / merge `f719f4e`

### New structure
```
server/features/
  execution/engine.ts
  execution/providers/openai.ts, index.ts
  execution/tools/agentTools.ts, registry.ts
  skills/index.ts, loader.ts
  state/store.ts, operations.ts
  ws/server.ts, dispatch.ts
  ws/handlers/chain.ts, chat.ts, cursor.ts, edge.ts, join.ts, node.ts, plan.ts
shared/types.ts
```

### Important
- **Old files in `server/execution/`, `server/state/`, `server/ws/` still exist** — they are not deleted, just shadowed by the new `server/features/` tree. `server/index.ts` now imports from `./features/ws/server.js`.
- `server/execution/providers/anthropic.ts` and `google.ts` remain on disk but are **not imported anywhere** in the new structure. They are dead files, safe to delete later.
- `src/types/index.ts` re-exports from `/shared/types.ts` via `export * from "../../shared/types.js"` and also keeps client-only types inline. This means some types are defined in `shared/types.ts` AND re-exported from `src/types/index.ts`. No duplicates — the barrel just re-exports.
- `tsconfig.json` has `"@shared/*": ["./shared/*"]` path alias and `"shared"` in `include`.

### What could break
- If any server file still imports from the old `../state/store`, `../execution/engine` etc. paths (not via `features/`), those could drift out of sync. Run `grep -r "from.*\.\./state/store" server/features/` to check.
- The `server/index.ts` import path is `./features/ws/server.js` — if that file is missing, the server won't start.

---

## Phase 4 — TypeScript Strict Mode

**Commit:** `e8aefa5` / merge `6abc53e`

### Changed file
- `tsconfig.json` — added `"noImplicitAny": true`, `"strictNullChecks": true`, `"strictFunctionTypes": true` (all redundant with `strict: true` which was already set, but now explicit)

### What could break
- Nothing — strict mode was already passing before these flags were made explicit. If new code is added with implicit `any`, tsc will now catch it.

---

## Phase 5 — Tool Approval Gates + Per-Node Model + Branch Expression

**Commit:** `a0e3686` / merge `8bbfa2c`

### Tool approval gates
New WS message flow:
```
server → client: tool:approval:request { approvalId, nodeId, toolName, args }
client → server: tool:approval:approve { approvalId }
client → server: tool:approval:deny   { approvalId }
```

**Server files modified:**
- `server/execution/agentTools.ts` — `executeAgentTool` accepts optional `ApprovalCallback`; `write_file` and `shell_exec` call it before executing
- `server/state/store.ts` — added `approvalResolvers: Map<string, ApprovalResolver>`
- `server/execution/engine.ts` — creates `requestToolApproval` callback, threads it into `callAIWithTools`
- `server/ws/handlers/chain.ts` — added `handleToolApprovalApprove` / `handleToolApprovalDeny`; chain stop clears pending approvals
- `server/ws/dispatch.ts` — routes `tool:approval:approve` and `tool:approval:deny`

**Client files modified:**
- `src/whiteboard/hooks/useSocket.ts` — handles `tool:approval:request`, exposes `pendingApprovals` Map, `approveToolCall()`, `denyToolCall()`
- `src/whiteboard/render.ts` — amber glow + dashed border + "approve?" badge when `approvalPending: true`
- `src/whiteboard/hooks/useRender.ts` — passes `pendingApprovalNodeIdsRef` to `renderBoard`
- `src/whiteboard/Whiteboard.tsx` — builds `pendingApprovalNodeIdsRef` from approvals map; wires callbacks to Sidebar
- `src/whiteboard/components/Sidebar.tsx` — approval UI in Config tab: tool name, args preview, Allow/Deny buttons

### Per-node model
- `server/execution/engine.ts` — agent nodes use their own `config.model`/`config.provider`, fallback is hardcoded `gpt-5.5`/`openai`. Start node `defaultModel`/`defaultProvider` no longer affects runtime.

### Branch expression toggle
- `src/whiteboard/config/nodeTypes.ts` — branch `defaultConfig` now has `conditionType: 'nl'`
- `src/whiteboard/components/Sidebar.tsx` — radio toggle: Natural Language / Expression
- `server/execution/engine.ts` — if `conditionType === 'expr'`, evaluates via `new Function("output", "length", ...)` with try/catch

### What could break
- Approval gate is a `Promise` that waits indefinitely. If the server restarts while waiting, the promise is dropped and the chain hangs client-side until timeout or page refresh.
- `new Function(...)` expression eval: user can pass `throw new Error()` or infinite loops. Currently no timeout — add `AbortController` or a 5s timeout if this becomes an issue.

---

## Phase 6 — Full UI Overhaul

**Commit:** `a40be33` / merge `113d11f`

### New files
- `public/favicon.svg` — node-chain SVG icon in `#16825d`
- `server/ws/handlers/skill.ts` — reads/writes `skills/*.md` from disk; handles `skill:list` and `skill:update`
- `src/whiteboard/components/SkillsPanel.tsx` — skill list + textarea editor + save button

### Modified files
- `index.html` — favicon link added
- `src/whiteboard/components/TitleBar.tsx` — Skills tab added to top nav (`WorkspaceTab: "canvas" | "plan" | "skills"`)
- `src/whiteboard/components/Sidebar.tsx` — three content tabs: Config, Trace, Chat; auto-switches to Trace on chain start
- `src/whiteboard/config/nodeTypes.ts` — SDLC roles expanded: +test, +debug, +refactor, +deploy
- `src/whiteboard/render.ts` — `ROLE_COLORS` map per role; "Agent" sub-label below role name
- `src/styles.css` — loading screen styles, sidebar tab strip, skills panel layout
- `src/whiteboard/Whiteboard.tsx` — loading overlay while `status === "connecting"`, Skills tab wired, SkillsPanel rendered
- `server/ws/dispatch.ts` — routes `skill:list`, `skill:update`

### Role color map
```
investigate: #1565c0   plan:    #2e7d32   design:   #6a1b9a
create:      #e65100   evaluate:#00838f   document: #4e342e
test:        #c62828   debug:   #37474f   refactor: #f9a825
deploy:      #0277bd
```

### What could break
- `SkillsPanel` sends `skill:list` on mount and waits for `skill:list:response`. If the server doesn't have `skill.ts` handler registered (e.g. running old server code), the panel will just show empty list indefinitely.
- `skill:update` writes to disk. If `skills/` directory doesn't exist at `process.cwd()`, write will fail silently. Make sure the server is started from the repo root.
- Tab auto-switch to Trace on `chainRunning` is a `useEffect` — if the component unmounts and remounts mid-run, it may not switch. Minor UX issue.

---

## Phase 7 — Excalidraw Plan Workspace

**Commit:** `7af8bef` / merge `7971d16`

### Summary
Replaced the custom `PlanNode`/`PlanEdge` graph with Excalidraw free-draw. Plan state is now a single opaque JSON string (`planExcalidrawData`).

### New WS protocol
```
client → server: plan:update { elements: string }   (JSON-stringified Excalidraw elements)
server → client: plan:updated { elements: string }
```

### Deleted files
- `src/whiteboard/renderPlan.ts`
- `src/whiteboard/hooks/usePlanRender.ts`
- `src/whiteboard/hooks/usePlanInteraction.ts`
- `src/whiteboard/components/PlanSidebarPanel.tsx`

### Modified files
- `server/state/store.ts` — `planExcalidrawData: string` + `setPlanExcalidrawData()`; old `planNodes`/`planEdges` Maps removed
- `server/state/operations.ts` — all plan CRUD functions removed
- `server/ws/handlers/plan.ts` — replaced with single `handlePlanUpdate()`
- `server/ws/handlers/join.ts` — `init` sends `planElements` (string) not `planNodes`/`planEdges`
- `server/ws/handlers/chat.ts` — plan operations removed from chat; workspace snapshot shows `plan.elementsCount`
- `src/types/index.ts` — `PlanNode`, `PlanEdge`, `PlanNodeKind`, `PlanGraphState` removed
- `src/whiteboard/components/PlanCanvas.tsx` — now renders `<Excalidraw>` component
- `src/whiteboard/Whiteboard.tsx` — removed old plan hooks; uses `planElements`/`sendPlanUpdate` from `useSocket`
- `src/whiteboard/hooks/useSocket.ts` — exposes `planElements: string` and `sendPlanUpdate(elements)`
- `package.json` — `@excalidraw/excalidraw` added

### What could break
- Excalidraw import paths (`@excalidraw/excalidraw/element/types`, `@excalidraw/excalidraw/types`) may shift between package versions. If types break after `npm update`, check Excalidraw changelog.
- `PlanCanvas` uses `initialData` memoised on mount only. If the server sends a `plan:updated` message before Excalidraw renders, those elements won't show until page reload. This is a known cold-start edge case.
- Chat can no longer create plan nodes — `planOperations` was removed from the chat handler. If you need chat-driven plan mutations, a new handler is required.

---

## Post-Merge Bug Fix — server/features/ Sync Issue

**Commit:** `c3b0202`

### Root Cause

Phase 3 (folder restructure) ran in a parallel worktree concurrently with Phase 1+2 (Responses API + skill loader). Phase 3 agent **copied the old engine/provider code** into `server/features/` BEFORE the Phase 1+2 changes were committed anywhere. When all branches were merged into `feat-2v`, the Phase 1+2 changes landed in the **old paths** (`server/execution/`), but the running server uses the **new paths** (`server/features/execution/`). Result: the server was running code with neither the Responses API nor the file-based skill loader.

### Symptoms
- Investigate node trace showed: `web_search → "No instant answers found for: ..."` (DuckDuckGo fallback)
- Final output was a generic markdown template, not real research with cited URLs

### Fix (3 files in server/features/)

**`server/features/execution/providers/openai.ts`**
- Added `callOpenAIResponses()` function using `POST /v1/responses` with `web_search_preview` built-in tool
- The old file only had `callOpenAI` (Chat Completions) and `callOpenAIToolRound`

**`server/features/skills/loader.ts`**
- Was: `export { NODE_SKILLS } from "./index.js"` — just re-exporting the inline string map
- Now: reads `skills/_base.md` and `skills/{role}.md` from disk using `readFileSync`, caches, returns combined prompt via `getSkillPrompt(role)`. Falls back to `NODE_SKILLS[role]` if file not found.

**`server/features/execution/engine.ts`**
- Changed import: `callOpenAIResponses` added from providers
- Changed import: `getSkillPrompt` from features skill loader (replacing `NODE_SKILLS` direct access)
- In `callAIWithTools`: added branch — if `allowedTools.includes("web_search")`, route to `callOpenAIResponses()` instead of Chat Completions + DuckDuckGo
- In `buildSystemPrompt`: replaced `NODE_SKILLS[role] || ""` with `getSkillPrompt(role)`

### Also Fixed
- **TitleBar squish** (`src/styles.css`): Phase 6 added a third tab (Skills) to the 40px titlebar, making it too cramped. Fixed: height 40→44px, tab padding 0 14px→0 13px, brand font-size 13→12px.

---

## Merge Conflict Notes (for Codex)

Three files had non-trivial conflicts that were hand-resolved:

### `src/whiteboard/hooks/useSocket.ts`
- Phase 7 added `planElements`/`sendPlanUpdate`
- Phase 5 added `pendingApprovals`/`approveToolCall`/`denyToolCall`
- Resolution: both sets of state and functions are present; `chain:complete`/`chain:stopped`/`chain:error` handlers now also call `setPendingApprovals(new Map())` to clear gates on chain end

### `src/whiteboard/components/Sidebar.tsx`
- Phase 6 restructured into three tabs (Config | Trace | Chat)
- Phase 5 added approval UI (was misplaced in Trace tab by conflict)
- Resolution: approval UI (`selectedNodeApprovals`) is in the **Config tab**, inside `vsc-cfg-panel`, after the review panel. Trace tab has `TraceTimeline` only. Phase 6's `SidebarContentTab` type and `useEffect` auto-switch are both present.

### `server/ws/dispatch.ts`
- Phase 7 imported `handlePlanUpdate`
- Phase 6 imported old `handlePlanNodeCreate/Update/Delete` + new `handleSkillList/handleSkillUpdate`
- Resolution: `handlePlanUpdate` (Phase 7) + `handleSkillList`/`handleSkillUpdate` (Phase 6); old plan node handlers dropped

---

## Key Environment Assumptions

| Assumption | Where it matters |
|---|---|
| Server started from repo root (`/Users/helios/canview`) | `skillLoader.ts` path, `skill.ts` write handler |
| `OPENAI_API_KEY` set in `.env` | All OpenAI calls |
| Model `gpt-5.5` supports Responses API | `callOpenAIResponses()` in `openai.ts` |
| `skills/` folder exists at repo root | Skill loading, skill editor save |
| `npm install` run after pulling | `@excalidraw/excalidraw` must be installed |

---

## Smoke Test Checklist

1. `npm run dev` starts without error
2. Open `http://localhost:3000` — loading screen appears briefly, then canvas loads
3. Favicon shows in browser tab
4. Top nav has: Canvas | Plan | Skills
5. **Canvas:** Drop Start node, set task to "Who is Adam Bell from Portlaoise, Ireland?"
6. **Canvas:** Drop Agent node, set role = Investigate — node turns blue
7. **Canvas:** Sidebar Config tab shows `web_search` and `fetch_url` pre-checked
8. **Canvas:** Run chain → sidebar auto-switches to Trace tab
9. **Trace:** Events show `tool: web_search` with query + URLs
10. **Node chips:** Agent node shows `model`, `tool: web_search`, `done: fetch_url` chips; click a chip to see popover
11. **Output:** Final output is a markdown report with real cited URLs — not a generic template
12. **Plan tab:** Opens Excalidraw free-draw canvas — can draw shapes, text, arrows
13. **Skills tab:** Shows list of 10 SDLC roles; click Investigate to see its `.md` prompt; edit and save
14. **Approval:** Create agent node with `write_file` tool; run a task that triggers file write → node turns amber with approve/deny chip in sidebar Config tab
15. `./node_modules/.bin/tsc --noEmit` → zero errors
16. `npm run build` → succeeds

---

## Files NOT Changed (still on old paths)

These old server files still exist and are **not imported** from the new `server/features/` tree. They are dead weight:

```
server/execution/engine.ts          (old, shadowed by server/features/execution/engine.ts)
server/execution/agentTools.ts      (old)
server/execution/skills.ts          (old, but still imported by skillLoader fallback)
server/execution/skillLoader.ts     (old, if it was created in old location — check)
server/execution/providers/openai.ts     (old)
server/execution/providers/anthropic.ts  (dead — not imported anywhere)
server/execution/providers/google.ts     (dead — not imported anywhere)
server/state/store.ts               (old)
server/state/operations.ts          (old)
server/ws/dispatch.ts               (old)
server/ws/handlers/*.ts             (old)
```

Safe to delete in a future cleanup pass. Do not delete without first confirming `server/index.ts` only imports from `server/features/`.
