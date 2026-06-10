import { useEffect, useMemo, useState } from "react";

interface PitchSlide {
  id: string;
  title: string;
  kicker?: string;
  body: string;
  points: string[];
  note: string;
}

const slides: PitchSlide[] = [
  {
    id: "title",
    title: "DISPATCH.AI",
    kicker: "The visual agent platform.",
    body: "A canvas-first way to build, debug, review, and run AI agent workflows.",
    points: [
      "Turns AI work into visible steps",
      "Chat becomes the orchestrator, not the whole product",
      "Built for real outputs: files, reviews, previews, and logs",
    ],
    note: "Open by contrasting this with normal chat. The important phrase is: AI work should be visible, debuggable, and repeatable.",
  },
  {
    id: "problem",
    title: "AI work disappears inside chat",
    body: "Today's AI tools are powerful, but the process is hidden. A model researches, reasons, edits, and evaluates in one long thread, and users cannot easily see what happened or fix the right step.",
    points: [
      "Context gets lost between turns and sessions",
      "Failures are hard to locate",
      "Generated work is difficult to trust or repeat",
      "Teams cannot review intermediate decisions cleanly",
    ],
    note: "This is the pain the demo should make obvious. A chat box is good for conversation, but weak as an execution environment.",
  },
  {
    id: "solution",
    title: "Make agents visual",
    body: "DISPATCH turns a request into a graph of typed agents. Each node has a job, each edge shows data flow, and each run records what happened.",
    points: [
      "Initialiser captures the goal and workspace",
      "Investigate, Plan, Design, Create, Evaluate, and Materialize nodes split the work",
      "Review nodes add human approval gates",
      "The terminal panel shows runtime progress and errors",
    ],
    note: "Point at the graph. Explain that the canvas is not decoration; it is the execution model.",
  },
  {
    id: "demo",
    title: "Example: build a website from intent",
    body: "The user can say: make a better website from this URL. DISPATCH proposes a chain, previews the graph, runs the agents, evaluates the result, and writes files when the output is safe.",
    points: [
      "Chat proposes typed canvas operations",
      "The graph can be inspected before applying",
      "Each node output is visible",
      "Materialize only writes valid file-map artifacts",
    ],
    note: "This is where you show the example. Keep it simple: request -> graph -> run logs -> output or preview.",
  },
  {
    id: "trust",
    title: "Built for control and trust",
    body: "The platform is designed around practical software workflow controls: review gates, retry from failed nodes, safe file writes, evidence tracking, and persistent workspace state.",
    points: [
      "Run ledger tracks facts, gaps, outputs, and evaluation issues",
      "Safe writes block invalid or missing file outputs",
      "Retry can start from the failed node instead of rerunning everything",
      "Chat memory and workspace state persist across sessions",
    ],
    note: "This is the credibility slide. It answers: why would a developer trust this more than a normal AI chat?",
  },
  {
    id: "audience",
    title: "Who it is for",
    body: "DISPATCH is for developers, makers, agencies, and technical teams who want AI agents to produce real work without losing visibility.",
    points: [
      "Developers building features or debugging code",
      "Agencies generating websites, audits, and client deliverables",
      "Founders turning rough ideas into working prototypes",
      "Teams that need human review before AI writes files",
    ],
    note: "Say this is not another chatbot. It is for people who need AI to participate in actual workflows.",
  },
  {
    id: "difference",
    title: "Why it is different",
    body: "Most AI products optimize the answer. DISPATCH optimizes the workflow around the answer.",
    points: [
      "Visual graph instead of hidden reasoning",
      "Typed nodes instead of one generic assistant",
      "Runtime terminal instead of silent failures",
      "Human review and safe materialization built in",
    ],
    note: "This is the strongest one-liner: we are not just generating output, we are giving users an operating system for agent work.",
  },
  {
    id: "roadmap",
    title: "What comes next",
    body: "The next milestone is making artifacts first-class: Create stores the file output, Evaluate returns a verdict, and Materialize writes the approved artifact.",
    points: [
      "First-class artifact store for generated files",
      "Stronger workspace memory and fact approval",
      "Hosted previews for generated sites",
      "Voice/conversation mode for live workflow control",
    ],
    note: "End with maturity. Acknowledge the current edge honestly: artifact handoff is the next major hardening step.",
  },
];

export function PitchDeck() {
  const [index, setIndex] = useState(0);
  const slide = slides[index];
  const progress = useMemo(() => Math.round(((index + 1) / slides.length) * 100), [index]);

  function go(nextIndex: number) {
    setIndex(Math.max(0, Math.min(slides.length - 1, nextIndex)));
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        go(index + 1);
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        go(index - 1);
      }
      if (event.key === "Home") go(0);
      if (event.key === "End") go(slides.length - 1);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index]);

  return (
    <main className="pitch-shell">
      <aside className="pitch-sidebar" aria-label="Pitch slides">
        <div className="pitch-brand">
          <span className="pitch-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>DISPATCH.AI</strong>
            <small>Pitch deck</small>
          </div>
        </div>

        <nav className="pitch-nav">
          {slides.map((item, slideIndex) => (
            <button
              key={item.id}
              type="button"
              className={`pitch-nav-item${slideIndex === index ? " active" : ""}`}
              onClick={() => go(slideIndex)}
            >
              <span>{String(slideIndex + 1).padStart(2, "0")}</span>
              {item.title}
            </button>
          ))}
        </nav>

        <div className="pitch-sidebar-foot">
          <span>{index + 1} / {slides.length}</span>
          <span>{progress}%</span>
        </div>
      </aside>

      <section className="pitch-stage" aria-live="polite">
        <header className="pitch-topbar">
          <a className="pitch-back" href="/">Back to app</a>
          <div className="pitch-progress" aria-label={`Slide progress ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        </header>

        <article className="pitch-slide">
          {slide.kicker && <p className="pitch-kicker">{slide.kicker}</p>}
          <h1>{slide.title}</h1>
          <p className="pitch-body">{slide.body}</p>

          <ul className="pitch-points">
            {slide.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </article>

        <footer className="pitch-footer">
          <div className="pitch-note">
            <strong>Presenter note</strong>
            <p>{slide.note}</p>
          </div>
          <div className="pitch-controls">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0}>
              Previous
            </button>
            <button type="button" onClick={() => go(index + 1)} disabled={index === slides.length - 1}>
              Next
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}
