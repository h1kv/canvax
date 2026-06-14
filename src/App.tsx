import { useState } from "react";
import { PitchDeck } from "./pitch/PitchDeck.js";
import { Whiteboard } from "./whiteboard/Whiteboard.js";

export default function App() {
  const [username, setUsername] = useState<string>("");
  const [workspace, setWorkspace] = useState<string>("");
  const [draftName, setDraftName] = useState<string>("");
  const [draftWorkspace, setDraftWorkspace] = useState<string>("");

  if (window.location.pathname === "/patch-pitch") {
    return <PitchDeck />;
  }

  function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = draftName.trim();
    const nextWorkspace = draftWorkspace.trim() || "default";
    if (nextName) {
      setUsername(nextName);
      setWorkspace(nextWorkspace);
    }
  }

  if (!username) {
    return (
      <main className="join-page">
        <div className="join-hero">
          <div className="join-logo-wrap" aria-hidden="true">
            <svg width="52" height="52" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="1.2" fill="#0078d4" opacity="0.9" />
              <rect x="8" y="1" width="5" height="5" rx="1.2" fill="#0078d4" opacity="0.55" />
              <rect x="1" y="8" width="5" height="5" rx="1.2" fill="#0078d4" opacity="0.55" />
              <rect x="8" y="8" width="5" height="5" rx="1.2" fill="#0078d4" opacity="0.28" />
            </svg>
          </div>
          <h1 className="join-brand">DISPATCH.AI</h1>
          <p className="join-tagline">The canvas for agents.</p>
        </div>

        <form className="join-form" onSubmit={handleJoin}>
          <input
            id="username"
            type="text"
            className="join-input"
            autoComplete="off"
            autoFocus
            maxLength={40}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="Your name"
          />
          <input
            id="workspace"
            type="text"
            className="join-input"
            autoComplete="off"
            maxLength={40}
            value={draftWorkspace}
            onChange={(event) => setDraftWorkspace(event.target.value)}
            placeholder="Workspace name (e.g. portfolio)"
          />
          <button type="submit" className="join-submit" disabled={!draftName.trim()}>
            Launch
          </button>
        </form>

        <div className="join-pills">
          <span className="join-pill">Initialiser Node</span>
          <span className="join-pill">Plan Board</span>
          <span className="join-pill">Live Collaboration</span>
        </div>
      </main>
    );
  }

  return <Whiteboard username={username} workspace={workspace} />;
}
