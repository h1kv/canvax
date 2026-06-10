# DISPATCH.AI — Implementation Spec

## Phase 1 Scope
- Initialiser node
- 6 SDLC nodes (Investigate, Plan, Design, Create, Evaluate, Doc)
- Materialize node
- Side port (midput) visual system
- OpenAI hardcoded

Phase 2 (later): chat assistant graph builder, model selection, task description auto-fill

---

## Step 1 — Initialiser Node

**typeId:** `initialiser`

**Config fields:**
- `workspacePath` — string, defaults to `./workspace`

**Behaviour:**
- Only one allowed per canvas — server enforces on `node:create`
- Flow output sends a trigger/empty signal to first connected node
- No model call, no AI — purely a config entry point

**Ports:**
- Bottom: flow output only (no flow input — it's the origin)
- No midput ports

---

## Step 2 — SDLC Node Types

Each SDLC node is its own `typeId` (not one generic "agent" with a role dropdown).
Separate types = distinct visual identity, distinct colors, cleaner canvas.

All 6 share the same engine execution path (call OpenAI with skill prompt + input),
but each has its own `skill.md` and visual treatment.

### Shared config fields (all SDLC nodes)
```
{
  model: "gpt-4o",          // hardcoded for phase 1, not exposed in UI
  tools: [],                 // per-node, see below
  maxToolCalls: 0,           // per-node
  taskPrompt: ""             // user-editable: what should this node do specifically
}
```

### Node definitions

| typeId | Label | Color | Tools enabled by default | maxToolCalls |
|---|---|---|---|---|
| `investigate` | Investigate | #2d6a9f | web_search, fetch_url | 6 |
| `plan` | Plan | #5a3e8c | none | 0 |
| `design` | Design | #1a6b4a | none | 0 |
| `create` | Create | #8c3e1a | none | 0 |
| `evaluate` | Evaluate | #7a3f3f | none | 0 |
| `doc` | Doc | #3a5a3a | none | 0 |

### Create node special behaviour
- Output is expected to be a delimited file map (for Materialize)
- `outputMode: "file-map"` config flag signals this to the engine
- skill.md instructs the AI to always output in delimiter format

### Ports (all SDLC nodes)
- Top: flow input
- Bottom: flow output
- Left: midput input (context edge, visually on left side)
- Right: midput input (context edge, visually on right side)

Both left and right midput ports accept context nodes.
Multiple context nodes can connect to the same port — concatenated in order.

---

## Step 3 — skill.md Files

Location: `skills/` directory

Files to create:
- `skills/investigate.md`
- `skills/plan.md`
- `skills/design.md`
- `skills/create.md`
- `skills/evaluate.md`
- `skills/doc.md`

### Investigate
You are a thorough research and investigation agent. Your job is to gather, analyze,
and extract all relevant facts before any building begins. Use web search and URL
fetching aggressively. Surface: existing state, key facts, constraints, risks, gaps,
and concrete evidence. Never fabricate. Output a structured findings report.

### Plan
You are a planning agent. Given investigation findings and a goal, produce a clear,
structured plan. Think like a senior engineer breaking down a project. Output:
phases, tasks per phase, key decisions made, open questions, and acceptance criteria.
Be specific. Vague plans are useless.

### Design
You are an architecture and design agent. Given a plan, produce concrete design
artifacts: component structure, file layout, interface contracts, data flow, visual
hierarchy (if UI). Make decisions explicit. Downstream agents must be able to implement
from your output alone.

### Create
You are a creation agent. Your job is to produce complete, working output — code,
content, or files — based on the design and context provided. You MUST output using
the file map delimiter format:

--- FILE: path/to/file.ext ---
[full file content here]

--- FILE: another/file.ext ---
[full file content here]

Never truncate. Never use placeholders. Output every file completely.

### Evaluate
You are a quality evaluation agent. Critically assess the output of the previous stage
against the original goal, plan, and design. Identify: missing requirements, quality
issues, inconsistencies, bugs, placeholder content. Be direct. Output a verdict
(PASS or FAIL) with specific issues listed. If FAIL, describe exactly what needs fixing.

### Doc
You are a documentation agent. Given a completed output, produce clear and useful
documentation. This includes: a README, usage instructions, architecture notes,
and any API or interface documentation. Write for the intended audience, not yourself.

---

## Step 4 — Materialize Node

**typeId:** `materialize`

**Behaviour:**
- Receives delimited file map string as flow input
- Parses on `--- FILE: {path} ---` delimiter
- Writes each file to `{workspacePath}/{path}` (reads workspacePath from Initialiser config via run context)
- Creates directories as needed (`mkdir -p`)
- Flow output: summary string listing all files written with byte counts

**Config fields:**
- None required — workspace path comes from run context

**Ports:**
- Top: flow input
- Bottom: flow output
- No midput ports (it's a mechanical node, not an AI agent)

**Error handling:**
- If input is not a valid file map (no delimiters found), emit error with the raw
  input preview so the user can see what the Create node actually produced

---

## Step 5 — Side Port (Midput) Visual System

### Canvas changes
Current context edges attach anywhere on the node border.
New system: explicit left/right port positions, visually distinct from flow ports.

**Port positions (world space):**
- Flow in: top-center of node
- Flow out: bottom-center of node  
- Midput left: left-center of node
- Midput right: right-center of node

**Visual treatment:**
- Flow ports: circles, same as current
- Midput ports: diamonds or squares — visually distinct shape
- Midput edges: dashed line to distinguish from solid flow edges

### Wiring rules
- Can only wire a context/text node → midput port
- Can only wire a SDLC node output → midput port (for chaining assertions)
- Cannot wire flow-out → midput port of same node (no self-loops)
- Enforced in `createEdge` server-side and `normalizeCanvasOperations` client-side

### Engine injection
When a node has midput inputs, their content is prepended to the user message
as a clearly labelled block:

```
[Context]
{midput content 1}

---

{midput content 2}

---

[Chain Input]
{flow input}

[Task At Hand]
{taskPrompt}
```

---

## Step 6 — Chat Panel Rebuild (Phase 2)

Deferred. Will be specced separately when Phase 1 nodes are built and stable.

---

---

## Resolved Decisions

**Global run context**
All nodes (including Materialize) access `workspacePath` and any other Initialiser
config via a global run context object passed into the chain engine at start.
No explicit edges needed. Initialiser config = global settings for the entire run.

**Node visual size**
No redesign. Keep current node dimensions and layout. SDLC nodes reuse existing
node shape/size — no new visual geometry to build.

**Node subtitle**
Each SDLC node displays the skill role as a small subtitle under the user-defined label.
e.g. label: "Research Phase", subtitle: "Investigate"
The subtitle is derived from the typeId, not editable.

**Two-layer prompt architecture**
Every SDLC node has two distinct prompt layers:

| Layer | Source | Purpose |
|---|---|---|
| System prompt | `skills/{role}.md` | Base identity — how the agent thinks, its ethic, output style |
| Task message | `taskPrompt` (user-editable per node) | The specific brief — what to actually do in this chain |

The skill.md never changes per chain. The taskPrompt changes every time.
Think of it as: skill.md = who you hired, taskPrompt = the brief you gave them.

**Full message structure sent to OpenAI:**
```
[System]
{skill.md content}

[User]
[Midput Context]        ← if any midput nodes are connected
{midput text 1}
---
{midput text 2}

[Chain Input]           ← output from upstream flow node
{flow input text}

[Task At Hand]          ← user's taskPrompt for this node
{taskPrompt}
```
