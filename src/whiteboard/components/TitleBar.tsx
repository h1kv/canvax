import type { WorkspaceTab } from "../../types/index.js";

interface TitleBarProps {
  status: string;
  userCount: number;
  workspaceTab: WorkspaceTab;
  onWorkspaceTabChange: (tab: WorkspaceTab) => void;
}

export function TitleBar({ status, userCount, workspaceTab, onWorkspaceTabChange }: TitleBarProps) {
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
          aria-selected={workspaceTab === "conversate"}
          className={`vsc-titlebar-tab${workspaceTab === "conversate" ? " active" : ""}`}
          onClick={() => onWorkspaceTabChange("conversate")}
        >
          Conversate
        </button>
      </div>

      <div className="vsc-titlebar-center" />

      <div className="vsc-titlebar-meta">
        <span className={`vsc-dot ${status}`} />
        <span>{userCount} online</span>
      </div>
    </header>
  );
}
