import { useEffect, useRef } from "react";
import type { TerminalEntry } from "../hooks/useSocket.js";

interface TerminalProps {
  logs: TerminalEntry[];
  open: boolean;
  height: number;
  onClose: () => void;
  onClear: () => void;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function levelPrefix(level: TerminalEntry["level"]): string {
  switch (level) {
    case "info":  return "›";
    case "warn":  return "⚠";
    case "error": return "✕";
    case "done":  return "✓";
  }
}

export function Terminal({ logs, open, height, onClose, onClear }: TerminalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <div
      className={`vsc-terminal-wrap${open ? "" : " vsc-terminal--closed"}`}
      style={{ height: open ? height : 0 }}
    >
      <div className="vsc-terminal-bar">
        <span className="vsc-terminal-title">TERMINAL</span>
        <button type="button" className="vsc-terminal-clear" onClick={onClear} title="Clear">
          Clear
        </button>
        <button type="button" className="vsc-terminal-close" onClick={onClose} title="Close terminal" aria-label="Close terminal">
          ×
        </button>
      </div>
      <div className="vsc-terminal-body" ref={bodyRef}>
        {logs.length === 0 ? (
          <span className="vsc-terminal-empty">No output yet. Run a chain to see logs.</span>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className={`vsc-terminal-line vsc-terminal-line--${entry.level}`}>
              <span className="vsc-terminal-ts">{formatTs(entry.ts)}</span>
              <span className="vsc-terminal-msg">{levelPrefix(entry.level)} {entry.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
