import { useState } from "react";
import { Whiteboard } from "./whiteboard/Whiteboard.jsx";

export default function App() {
  const [username, setUsername] = useState("");
  const [draftName, setDraftName] = useState("");

  function handleJoin(event) {
    event.preventDefault();
    const nextName = draftName.trim();

    if (nextName) {
      setUsername(nextName);
    }
  }

  if (!username) {
    return (
      <main className="join-page">
        <form className="join-panel" onSubmit={handleJoin}>
          <div>
            <h1>canvax</h1>
            <p>Enter a name to join the shared local whiteboard.</p>
          </div>

          <label htmlFor="username">Username</label>
          <div className="join-row">
            <input
              id="username"
              type="text"
              autoComplete="off"
              autoFocus
              maxLength={40}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Your name"
            />
            <button type="submit" disabled={!draftName.trim()}>
              Join
            </button>
          </div>
        </form>
      </main>
    );
  }

  return <Whiteboard username={username} />;
}
