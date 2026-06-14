<div align="center">

# DISPATCH.AI

**The canvas for agents.**

An open-source visual canvas / IDE for building, running, and shipping AI agent
workflows. Place nodes on an infinite canvas, wire them top-to-bottom, press
**Run**, and the chain executes — each node passing its output downstream.

[![License: MIT](https://img.shields.io/badge/license-MIT-635bff.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-16825d.svg)](#prerequisites)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-0078d4.svg)](CONTRIBUTING.md)

[Quick start](#quick-start) · [Features](#features) · [Architecture](#architecture) · [Node reference](#node-reference) · [Contributing](CONTRIBUTING.md)

</div>

---

## What is DISPATCH.AI?

Most AI tooling makes *you* the runtime: you prompt, wait, copy, paste, and
re-prompt in a loop. DISPATCH lets you lay the work out **as a graph** instead.
Each node runs a model (with tools), edges carry output and control from one
node to the next, and the whole chain runs top-to-bottom — locally, on your own
machine or self-hosted infrastructure.

It is a real-time, multiplayer canvas (collaborate over your LAN, no cloud
required), multi-provider (OpenAI, Anthropic, Google, or local models — picked
per node), and human-in-the-loop (Review nodes pause for approval).

> **Status:** early and moving fast. Built in the open by a solo developer —
> see [SPONSORS.md](SPONSORS.md) for why help matters. Expect rough edges, and
> please [open issues / PRs](CONTRIBUTING.md).

## Features

- **Visual canvas** — drag nodes onto an infinite grid and wire them together.
- **Multi-provider, per node** — OpenAI / Anthropic / Google / local; hotswap
  the provider and model on any node, mid-run.
- **Live tools** — agents can call `web_search`, `fetch_url`, `read_file`,
  `write_file`, `list_files`, and `shell_exec` during a run.
- **Human-in-the-loop** — Review nodes pause the chain for Approve / Reject.
- **Branch & merge** — Parallel fan-out, Merge fan-in, and Context inputs.
- **Real-time multiplayer** — named cursors, shared state, and live editing over
  WebSockets on your local network.
- **Agentic voice control** — talk to your canvas via the VoiceOrb (OpenAI
  Realtime).
- **Inbuilt terminal** — a real CLI inside the app (`run`, `stop`, `retry`, …).
- **Self-hostable & local-first** — runs entirely on your machine; your data
  never has to leave it.

See the [roadmap](#roadmap) for what's in development.

## Quick start

### Prerequisites

- **Node.js ≥ 20** and **npm**
- At least one model-provider API key (OpenAI, Anthropic, or Google)

### Install & run

```bash
git clone https://github.com/h1kv/dispatch-tooling.git
cd dispatch-tooling
npm install

cp .env.example .env      # then add your API key(s)
npm run dev
```

Open **http://localhost:3000**. The server also prints your local-network URLs
so teammates on the same network can join the same canvas.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server (Vite middleware + WebSocket server). |
| `npm run build` | Build the frontend to `dist/`. |
| `npm run preview` | Serve the production build. |
| `npm test` | Run the test suite (`node --test`). |

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full list. The essentials:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | Model providers (need at least one). |
| `OPENAI_MODEL` | Default OpenAI model (e.g. `gpt-4.1`). |
| `RTM_OPENAI` | OpenAI Realtime key for agentic voice control (optional). |
| `VERCEL_TOKEN` / `VERCEL_PROJECT_ID` | For the Deploy node (optional). |
| `PORT` | Server port (default `3000`). |

## Architecture

```
dispatch-tooling/
├── src/                    # React + Vite frontend
│   └── whiteboard/         # the canvas app
│       ├── components/     # Canvas, Sidebar, Terminal, VoiceOrb, panels…
│       ├── hooks/          # useInteraction, useRender, useSocket
│       └── render.ts       # canvas rendering
├── server/                 # Express + WebSocket backend
│   └── features/
│       ├── chat/           # graph chat: layout, serialize, simulate, validate
│       ├── execution/      # the run engine, orchestrator, providers, tools
│       ├── state/          # in-memory store, operations, review store
│       └── ws/             # websocket server + per-message handlers
├── shared/                 # types + node registry shared by client & server
├── skills/                 # markdown skill definitions for node behaviour
├── frontsite/              # the public marketing site + docs hub (static)
└── tests/                  # test suite
```

The frontend renders the canvas and talks to the server over a WebSocket. The
server holds canvas state, runs the execution engine (which calls model
providers and tools), and broadcasts updates to all connected clients.

## Node reference

A chain is built from typed nodes wired top-to-bottom. The 13 node types:

| Node | Role |
| --- | --- |
| **Initialiser** | Entry point — sets the task + workspace + default model. |
| **Investigate** | Research with live tools (`web_search`, `fetch_url`). |
| **Plan** | Turn input into a structured roadmap. |
| **Design** | Produce a spec / architecture. |
| **Create** | Generate the artefact (code, content, drafts). |
| **Evaluate** | Critique the previous output for quality. |
| **Doc** | Produce docs, summaries, changelogs. |
| **Apply** | Apply changes to the workspace. |
| **Context** | Feed shared context into downstream nodes. |
| **Review** | Human checkpoint — pause for Approve / Reject. |
| **Parallel** | Fan a task out to run branches concurrently. |
| **Merge** | Fan-in — converge branches into one result. |
| **Deploy** | Ship the workspace (e.g. to Vercel). |

Nodes are defined in [`shared/nodeRegistry.ts`](shared/nodeRegistry.ts) and their
behaviour in [`skills/`](skills/) — they are customizable, and new ones can be
added.

## Roadmap

Actively in development / testing — see the [feature pages](https://github.com/h1kv/dispatch-tooling)
for details:

- Advanced orchestration controls (conditional routing, retries, loops, sub-canvases)
- Directive model control via a `MODELS.md` file
- Analytics — node-delegated token + cost tracking across all providers
- Git-backed canvas versioning
- Local model support (Ollama / llama.cpp / LM Studio)
- Model Prompt — generate whole node graphs from a prompt
- Subscription-model integration via MCP
- Testing-pipeline nodes, canvas planning, richer multiplayer
- A portable CLI + one-line install

## Contributing

Contributions are very welcome — code, issues, docs, and ideas all help. Start
with [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## Sponsors

DISPATCH.AI is built in the open and supported by the people and organisations
in [SPONSORS.md](SPONSORS.md). Testing AI orchestration at real API prices is
expensive — sponsorship and contributions directly fund development.

## License

[MIT](LICENSE) © DISPATCH.AI contributors
