# DISPATCH.AI — Revamp Concept Plan

## Core Idea
A visual AI orchestration system for the Software Development Life Cycle (SDLC).
Users wire nodes on a canvas to build AI agent chains. Each node is an AI agent
whose behavior is defined by a `skill.md` file. No coding required, any skill level.

---

## Node Set

### Initialiser (infrastructure)
- Entry point for every graph. One per canvas.
- Config fields: workspace path, task description, default model
- API keys live in `.env` only — never in the graph

### SDLC Nodes (user-wired, any order)
| Node | Role |
|---|---|
| Investigate | Research, gather facts, analyze existing state |
| Plan | Produce a structured plan (like Claude's /plan output) |
| Design | Architecture, structure, component layout |
| Create | Generate code/content as output |
| Evaluate | Quality check, critique, verify against goals |
| Doc | Documentation, README, summaries |

Each backed by a `skills/{role}.md` file with a detailed AI persona/instructions.

### Materialize (infrastructure)
- Receives a delimited file map from a Create node
- Parses it and writes each file to the workspace
- Delimiter format: `--- FILE: path/to/file.ext ---`
- Outputs a summary of files written

---

## Port System

### Flow ports (vertical)
- **Top**: flow input (receives output from upstream node)
- **Bottom**: flow output (sends output to downstream node)

### Midput ports (horizontal)
- **Left or Right**: accepts a context/text node as side-car enrichment
- Injected into the node's prompt as additional context
- Not typed — plain text, manually authored and wired
- Nodes do NOT auto-produce midput assertions (tabled for future)

---

## Multi-file Output (Plan A)
Create node outputs a delimited file map:
```
--- FILE: src/index.html ---
<!DOCTYPE html>...

--- FILE: src/styles.css ---
body { margin: 0; }
```
Materialize node parses delimiters and writes each file. Clean single node,
no explosion of individual File Write nodes in the graph.

---

## What's NOT in scope (for now)
- Infrastructure nodes: Branch, Fork, Review, Memory, Shell-Exec
- Typed/schematic midput assertions (nodes producing structured output assertions)
- External integrations (GitHub, Jira, Figma, etc.)
- Multi-user collaboration

---

## Build Order
1. Initialiser node — config fields, entry point foundation
2. SDLC node types + skill.md files — six roles, port shapes, prompts
3. Side port (midput) visual system — left/right ports on canvas, wiring UI
4. Materialize node — delimiter parser + file writer
5. Chat panel rebuild — teach it the new node vocabulary for auto-graph-building
