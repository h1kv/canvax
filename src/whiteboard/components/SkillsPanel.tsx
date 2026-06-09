import { useState, useEffect, useCallback } from "react";

interface Skill {
  role: string;
  content: string;
}

interface SkillsPanelProps {
  socketRef: React.MutableRefObject<WebSocket | null>;
}

export function SkillsPanel({ socketRef }: SkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loading, setLoading] = useState(true);

  const sendJson = useCallback((msg: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(msg));
    }
  }, [socketRef]);

  useEffect(() => {
    // Request skills list on mount
    sendJson({ type: "skill:list" });

    function handleMessage(event: MessageEvent) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      if (message.type === "skill:list:response") {
        const incoming = message.skills as Skill[] | undefined;
        if (Array.isArray(incoming)) {
          setSkills(incoming);
          setLoading(false);
          if (incoming.length > 0 && selectedRole === null) {
            setSelectedRole(incoming[0].role);
            setEditContent(incoming[0].content);
          }
        }
      }

      if (message.type === "skill:update:response") {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      }

      if (message.type === "skill:update:error") {
        setSaveStatus("error");
        setTimeout(() => setSaveStatus("idle"), 3000);
      }
    }

    const ws = socketRef.current;
    if (ws) {
      ws.addEventListener("message", handleMessage);
    }

    return () => {
      if (ws) {
        ws.removeEventListener("message", handleMessage);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendJson]);

  function handleSelectRole(role: string) {
    const skill = skills.find((s) => s.role === role);
    if (skill) {
      setSelectedRole(role);
      setEditContent(skill.content);
      setSaveStatus("idle");
    }
  }

  function handleSave() {
    if (!selectedRole) return;
    setSaveStatus("saving");
    sendJson({ type: "skill:update", role: selectedRole, content: editContent });
    // Update local state immediately
    setSkills((prev) =>
      prev.map((s) => s.role === selectedRole ? { ...s, content: editContent } : s)
    );
  }

  if (loading) {
    return (
      <div className="skills-panel">
        <div className="skills-loading">Loading skills…</div>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="skills-panel">
        <div className="skills-loading">No skills found. Add .md files to the skills/ folder.</div>
      </div>
    );
  }

  return (
    <div className="skills-panel">
      <div className="skills-list">
        {skills.map((skill) => (
          <button
            key={skill.role}
            type="button"
            className={`skills-list-item${selectedRole === skill.role ? " active" : ""}`}
            onClick={() => handleSelectRole(skill.role)}
          >
            {skill.role}
          </button>
        ))}
      </div>
      <div className="skills-editor">
        {selectedRole ? (
          <>
            <div className="skills-editor-header">
              <span className="skills-editor-title">{selectedRole}.md</span>
              <button
                type="button"
                className={`skills-save-btn${saveStatus === "saving" ? " saving" : ""}`}
                onClick={handleSave}
                disabled={saveStatus === "saving"}
              >
                {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Error" : "Save"}
              </button>
            </div>
            <textarea
              className="skills-editor-textarea"
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value);
                if (saveStatus === "saved") setSaveStatus("idle");
              }}
              spellCheck={false}
            />
            {saveStatus === "saved" && (
              <div className="skills-save-success">Saved successfully.</div>
            )}
            {saveStatus === "error" && (
              <div className="skills-save-error">Failed to save. Check server logs.</div>
            )}
          </>
        ) : (
          <div className="skills-editor-empty">Select a skill to edit.</div>
        )}
      </div>
    </div>
  );
}
