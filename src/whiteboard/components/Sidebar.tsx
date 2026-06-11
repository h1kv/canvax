import type { ChatGraphOperation, ChatTranscriptMessage, NodeV2, NodeV2Config, NodeV2Type, SkillMeta, WorkspaceTab } from "../../types/index.js";
import { NODE_REGISTRY, SDLC_NODE_TYPES } from "../../../shared/nodeRegistry.js";
import { ChatPanel } from "./ChatPanel.js";

interface SidebarProps {
  workspaceTab: WorkspaceTab;
  sidebarTab: string | null;
  mode: string;
  placingType: NodeV2Type | null;
  selectedNode: NodeV2 | null;
  selectedTitleDraft: string;
  hasInitialiser: boolean;
  chainRunning: boolean;
  onSetMode: (mode: "select" | "place", nodeType?: NodeV2Type) => void;
  onPlaceNode: (type: NodeV2Type) => void;
  onTitleChange: (title: string) => void;
  onConfigChange: (config: Partial<NodeV2Config>) => void;
  onDeleteNode: () => void;
  onRunChain: () => void;
  onStopChain: () => void;
  onRetryFrom: (nodeId: string) => void;
  socketRef: React.MutableRefObject<WebSocket | null>;
  chatMessages: ChatTranscriptMessage[];
  chatHydrationVersion: number;
  onPendingChatOpsChange: (operations: ChatGraphOperation[] | null) => void;
  skillsMeta: Record<string, SkillMeta>;
}

function SidebarPlaceholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="vsc-chat-placeholder">
      <p>{title}</p>
      <p className="sub">{body}</p>
    </div>
  );
}

function NodeButton({
  type,
  isPlacing,
  onPlace,
}: {
  type: NodeV2Type;
  isPlacing: boolean;
  onPlace: (type: NodeV2Type) => void;
}) {
  const def = NODE_REGISTRY[type];
  return (
    <button
      type="button"
      className={`vsc-list-item${isPlacing ? " vsc-list-item--placing" : ""}`}
      onClick={() => onPlace(type)}
      title={`Place ${def.label} node`}
    >
      <span className="vsc-node-dot" style={{ background: def.accent }} />
      <span className="vsc-list-label">{def.label}</span>
    </button>
  );
}

function NodeProperties({
  node,
  titleDraft,
  onTitleChange,
  onConfigChange,
  onDelete,
  onRetryFrom,
  skillMeta,
}: {
  node: NodeV2;
  titleDraft: string;
  onTitleChange: (t: string) => void;
  onConfigChange: (c: Partial<NodeV2Config>) => void;
  onDelete: () => void;
  onRetryFrom: (nodeId: string) => void;
  skillMeta?: SkillMeta;
}) {
  const def = NODE_REGISTRY[node.type];
  const isSDLC = SDLC_NODE_TYPES.includes(node.type as typeof SDLC_NODE_TYPES[number]);

  return (
    <div className="vsc-inspector">
      {/* Header */}
      <div className="vsc-inspector-hdr">
        <span
          className="vsc-inspector-badge"
          style={{ background: `${def.accent}18`, color: def.accent, borderColor: `${def.accent}40` }}
        >
          {def.label}
        </span>
        <span className="vsc-inspector-pos">{Math.round(node.x)}, {Math.round(node.y)}</span>
        {node.status && node.status !== "idle" && (
          <span className={`vsc-inspector-status vsc-inspector-status--${node.status}`}>
            {node.status}
          </span>
        )}
      </div>

      <div className="vsc-inspector-body">
        {/* Title */}
        <label className="vsc-field">
          <span className="vsc-field-label">Title</span>
          <input
            className="vsc-field-input"
            type="text"
            value={titleDraft}
            onChange={(e) => onTitleChange(e.target.value)}
            spellCheck={false}
          />
        </label>

        {/* Workspace path + initial context for Initialiser */}
        {node.type === "initialiser" && (
          <>
            <label className="vsc-field">
              <span className="vsc-field-label">Workspace Path</span>
              <input
                className="vsc-field-input"
                type="text"
                value={node.config?.workspacePath ?? ""}
                onChange={(e) => onConfigChange({ workspacePath: e.target.value })}
                spellCheck={false}
                placeholder="./workspace"
              />
            </label>
            <label className="vsc-field">
              <span className="vsc-field-label">Initial Context</span>
              <textarea
                className="vsc-field-textarea"
                value={node.config?.content ?? ""}
                onChange={(e) => onConfigChange({ content: e.target.value })}
                spellCheck={false}
                placeholder="Seed text that flows into the first chain node…"
                rows={4}
              />
            </label>
          </>
        )}

        {/* Context content */}
        {node.type === "context" && (
          <label className="vsc-field">
            <span className="vsc-field-label">Context</span>
            <textarea
              className="vsc-field-textarea"
              value={node.config?.content ?? ""}
              onChange={(e) => onConfigChange({ content: e.target.value })}
              spellCheck={false}
              placeholder={"Context to inject into connected nodes…\nOne URL per line — each is fetched automatically."}
              rows={5}
            />
          </label>
        )}

        {/* Task prompt for SDLC nodes */}
        {isSDLC && (
          <label className="vsc-field">
            <span className="vsc-field-label">Task Prompt</span>
            <textarea
              className="vsc-field-textarea"
              value={node.config?.taskPrompt ?? ""}
              onChange={(e) => onConfigChange({ taskPrompt: e.target.value })}
              spellCheck={false}
              placeholder={`What should ${def.label} do in this run?`}
              rows={4}
            />
          </label>
        )}

        {/* Skill config (read-only) */}
        {isSDLC && skillMeta && (
          <div className="vsc-skill-meta">
            <span className="vsc-skill-meta-hdr">Skill Config</span>
            <div className="vsc-skill-meta-grid">
              {skillMeta.model && <><span className="vsc-skill-meta-key">model</span><span className="vsc-skill-meta-val">{skillMeta.model}</span></>}
              {skillMeta.temperature !== undefined && <><span className="vsc-skill-meta-key">temp</span><span className="vsc-skill-meta-val">{skillMeta.temperature}</span></>}
              {skillMeta.maxTokens !== undefined && <><span className="vsc-skill-meta-key">max_tokens</span><span className="vsc-skill-meta-val">{skillMeta.maxTokens}</span></>}
              {skillMeta.tools && skillMeta.tools.length > 0 && <><span className="vsc-skill-meta-key">tools</span><span className="vsc-skill-meta-val">{skillMeta.tools.join(", ")}</span></>}
            </div>
            {skillMeta.description && <p className="vsc-skill-meta-desc">{skillMeta.description}</p>}
          </div>
        )}

        {/* Output hint — full output is in the bottom panel Output tab */}
        {node.status === "done" && node.output && (
          <p className="vsc-props-hint">Output available in panel → Output tab.</p>
        )}
        {node.status === "error" && node.output && (
          <div className="vsc-field">
            <span className="vsc-field-label" style={{ color: "var(--err)" }}>Error</span>
            <div className="vsc-field-error">{node.output.slice(0, 300)}</div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="vsc-inspector-footer">
        {(node.status === "error" || node.status === "done") && (
          <button
            type="button"
            className="vsc-inspector-retry"
            onClick={() => onRetryFrom(node.id)}
            title="Retry this node and all downstream nodes"
          >
            ↺ Retry from here
          </button>
        )}
        <button type="button" className="vsc-inspector-delete" onClick={onDelete}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H2.506a.58.58 0 0 0-.01 0H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66H14.5a.5.5 0 0 0 0-1h-.995a.59.59 0 0 0-.01 0z"/>
          </svg>
          Delete node
        </button>
      </div>
    </div>
  );
}

export function Sidebar({
  workspaceTab,
  sidebarTab,
  mode,
  placingType,
  selectedNode,
  selectedTitleDraft,
  hasInitialiser,
  chainRunning,
  onSetMode,
  onPlaceNode,
  onTitleChange,
  onConfigChange,
  onDeleteNode,
  onRunChain,
  onStopChain,
  onRetryFrom,
  socketRef,
  chatMessages,
  chatHydrationVersion,
  onPendingChatOpsChange,
  skillsMeta,
}: SidebarProps) {
  const isChat = sidebarTab === "chat";
  const isToolbox = sidebarTab === "toolbox";

  function handlePlace(type: NodeV2Type) {
    if (mode === "place" && placingType === type) {
      onSetMode("select");
    } else {
      onPlaceNode(type);
    }
  }

  return (
    <aside className={`vsc-sidebar${isChat ? " vsc-sidebar--chat" : ""}`} aria-hidden={sidebarTab === null}>
      <ChatPanel
        socketRef={socketRef}
        workspaceTab={workspaceTab}
        selectedNodeId={selectedNode?.id ?? null}
        initialMessages={chatMessages}
        hydrationVersion={chatHydrationVersion}
        hidden={!isChat}
        onPendingOpsChange={onPendingChatOpsChange}
      />

      {isToolbox && workspaceTab === "canvas" && (
        <>
          <div className="vsc-sidebar-head">Canvas</div>

          {/* Run / Stop */}
          <div className="vsc-sidebar-section">
            {chainRunning ? (
              <button type="button" className="vsc-chain-btn vsc-chain-btn--stop" onClick={onStopChain}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                  <rect width="10" height="10" rx="2" />
                </svg>
                Stop Chain
              </button>
            ) : (
              <button
                type="button"
                className="vsc-chain-btn"
                onClick={onRunChain}
                disabled={!hasInitialiser}
                title={!hasInitialiser ? "Add an Initialiser node first" : undefined}
              >
                <svg width="10" height="11" viewBox="0 0 10 11" fill="currentColor" aria-hidden="true">
                  <path d="M0 1.5 9 5.5 0 9.5z" />
                </svg>
                Run Chain
              </button>
            )}
          </div>

          {/* Infrastructure */}
          <div className="vsc-sidebar-section">
            <div className="vsc-section-hdr">Infrastructure</div>
            <div className="vsc-list">
              {(["initialiser", "apply", "context", "review"] as NodeV2Type[]).map((type) => (
                <NodeButton
                  key={type}
                  type={type}
                  isPlacing={mode === "place" && placingType === type}
                  onPlace={handlePlace}
                />
              ))}
            </div>
          </div>

          {/* SDLC */}
          <div className="vsc-sidebar-section">
            <div className="vsc-section-hdr">SDLC</div>
            <div className="vsc-list">
              {SDLC_NODE_TYPES.map((type) => (
                <NodeButton
                  key={type}
                  type={type}
                  isPlacing={mode === "place" && placingType === type}
                  onPlace={handlePlace}
                />
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="vsc-sidebar-section">
            <div className="vsc-section-hdr">Actions</div>
            <button
              type="button"
              className={`vsc-list-item${mode === "select" ? " vsc-list-item--active" : ""}`}
              onClick={() => onSetMode("select")}
            >
              <svg className="vsc-list-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.5 1 7 13.5l2.1-5.2L14.5 6z" />
              </svg>
              <span className="vsc-list-label">Pointer</span>
            </button>
          </div>

          {/* Properties */}
          <div className="vsc-sidebar-section vsc-sidebar-section--grow">
            <div className="vsc-section-hdr">Properties</div>
            {selectedNode ? (
              <NodeProperties
                node={selectedNode}
                titleDraft={selectedTitleDraft}
                onTitleChange={onTitleChange}
                onConfigChange={onConfigChange}
                onDelete={onDeleteNode}
                onRetryFrom={onRetryFrom}
                skillMeta={skillsMeta[selectedNode.type]}
              />
            ) : (
              <p className="vsc-props-empty">Select a node to edit its properties.</p>
            )}
          </div>
        </>
      )}

      {isToolbox && workspaceTab === "plan" && (
        <SidebarPlaceholder
          title="Plan"
          body="The Plan tab is a freeform Excalidraw workspace."
        />
      )}
    </aside>
  );
}
