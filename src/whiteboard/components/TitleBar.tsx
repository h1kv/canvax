import type { WorkspaceTab } from "../../types/index.js";

interface TitleBarProps {
  status: string;
  userCount: number;
  chainRunning: boolean;
  runningNodeLabel: string | null;
  workspaceTab: WorkspaceTab;
  onRun: () => void;
  onStop: () => void;
  onWorkspaceTabChange: (tab: WorkspaceTab) => void;
}

export function TitleBar({ status, userCount, chainRunning, runningNodeLabel, workspaceTab, onRun, onStop, onWorkspaceTabChange }: TitleBarProps) {
  return (
    <header className="vsc-titlebar">
      <div className="vsc-titlebar-brand">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="5" height="5" rx="1" fill="currentColor" opacity="0.8" />
          <rect x="8" y="1" width="5" height="5" rx="1" fill="currentColor" opacity="0.5" />
          <rect x="1" y="8" width="5" height="5" rx="1" fill="currentColor" opacity="0.5" />
          <rect x="8" y="8" width="5" height="5" rx="1" fill="currentColor" opacity="0.3" />
        </svg>
        DISPATCH.AI
      </div>

      <div className="vsc-titlebar-nav" role="tablist" aria-label="Workspace">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "canvas"}
          className={`vsc-titlebar-tab${workspaceTab === "canvas" ? " active" : ""}`}
          onClick={() => onWorkspaceTabChange("canvas")}
        >
          Canvas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "plan"}
          className={`vsc-titlebar-tab${workspaceTab === "plan" ? " active" : ""}`}
          onClick={() => onWorkspaceTabChange("plan")}
        >
          Plan
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === "skills"}
          className={`vsc-titlebar-tab${workspaceTab === "skills" ? " active" : ""}`}
          onClick={() => onWorkspaceTabChange("skills")}
        >
          Skills
        </button>
      </div>

      <div className="vsc-titlebar-center">
        {chainRunning && runningNodeLabel && (
          <span className="vsc-chain-chip">
            <span className="vsc-chain-chip-dot" />
            {runningNodeLabel}
          </span>
        )}
      </div>

      <div className="vsc-titlebar-actions">
        {chainRunning ? (
          <button type="button" className="vsc-run-btn vsc-run-btn--stop" onClick={onStop}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <rect x="1" y="1" width="8" height="8" rx="1"/>
            </svg>
            Stop
          </button>
        ) : (
          <button type="button" className="vsc-run-btn" onClick={onRun}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <polygon points="2,1 9,5 2,9"/>
            </svg>
            Run
          </button>
        )}
      </div>

      <div className="vsc-titlebar-meta">
        <span className={`vsc-dot ${status}`} />
        <span>{userCount} online</span>
      </div>
    </header>
  );
}
