import { useState, useEffect } from "react";
import type { BoardNode, NodeTypeConfig, NodeStatus, WorkspaceTab, NodeRunTraceEvent } from "../../types/index.js";
import type { PendingApproval } from "../hooks/useSocket.js";
import { ChatPanel } from "./ChatPanel.js";

const PROVIDERS = ["openai", "anthropic", "google"] as const;
const MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-5.5", "o1", "o1-mini"],
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  google: ["gemini-1.5-pro", "gemini-1.5-flash"],
};

const STATUS_ICON: Record<NodeStatus, string> = {
  idle: "○",
  running: "●",
  done: "✓",
  error: "✕",
  paused: "⏸",
};

const STATUS_COLOR: Record<NodeStatus, string> = {
  idle: "#a0a0a0",
  running: "#0078d4",
  done: "#16825d",
  error: "#e02020",
  paused: "#e65100",
};

function FileWriteConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  return (
    <>
      <ConfigField label="File Path">
        <input
          className="vsc-cfg-select"
          type="text"
          value={(node.config?.path as string) || ""}
          placeholder="output/result.md"
          onChange={(e) => onConfigChange({ path: e.target.value })}
        />
      </ConfigField>
      <ConfigField label="Mode">
        <select
          className="vsc-cfg-select"
          value={(node.config?.mode as string) || "write"}
          onChange={(e) => onConfigChange({ mode: e.target.value })}
        >
          <option value="write">Overwrite</option>
          <option value="append">Append</option>
        </select>
      </ConfigField>
    </>
  );
}

function BranchConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const provider = (node.config?.provider as string) || "openai";
  const model = (node.config?.model as string) || MODELS[provider]?.[0] || "";
  const conditionType = (node.config?.conditionType as string) || "nl";
  const isExpr = conditionType === "expr";

  return (
    <>
      <ConfigField label="Condition Mode">
        <div style={{ display: "flex", gap: 8 }}>
          <label className="vsc-cfg-check-label" style={{ flex: 1, justifyContent: "center", padding: "4px 0", border: `1px solid ${!isExpr ? "#0078d4" : "#d0d0d0"}`, borderRadius: 4, background: !isExpr ? "#e8f1fb" : "transparent", cursor: "pointer" }}>
            <input
              type="radio"
              name={`conditionType-${node.id}`}
              value="nl"
              checked={!isExpr}
              onChange={() => onConfigChange({ conditionType: "nl" })}
              style={{ marginRight: 4 }}
            />
            Natural Language
          </label>
          <label className="vsc-cfg-check-label" style={{ flex: 1, justifyContent: "center", padding: "4px 0", border: `1px solid ${isExpr ? "#0078d4" : "#d0d0d0"}`, borderRadius: 4, background: isExpr ? "#e8f1fb" : "transparent", cursor: "pointer" }}>
            <input
              type="radio"
              name={`conditionType-${node.id}`}
              value="expr"
              checked={isExpr}
              onChange={() => onConfigChange({ conditionType: "expr" })}
              style={{ marginRight: 4 }}
            />
            Expression
          </label>
        </div>
      </ConfigField>

      {!isExpr ? (
        <>
          <ConfigField label="Condition (natural language)">
            <textarea
              className="vsc-cfg-textarea"
              rows={3}
              value={(node.config?.condition as string) || ""}
              placeholder="Did the previous step produce valid, working code?"
              onChange={(e) => onConfigChange({ condition: e.target.value })}
            />
          </ConfigField>
          <p className="vsc-cfg-hint">
            The AI reads the previous node's output and answers true/false based on your condition.
            Routes to <strong>True</strong> or <strong>False</strong> output ports.
          </p>
          <ConfigField label="Provider">
            <select
              className="vsc-cfg-select"
              value={provider}
              onChange={(e) => onConfigChange({ provider: e.target.value, model: MODELS[e.target.value]?.[0] || "" })}
            >
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </ConfigField>
          <ConfigField label="Model">
            <select
              className="vsc-cfg-select"
              value={model}
              onChange={(e) => onConfigChange({ model: e.target.value })}
            >
              {(MODELS[provider] || []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </ConfigField>
        </>
      ) : (
        <>
          <ConfigField label="Expression">
            <input
              className="vsc-cfg-select vsc-cfg-textarea--mono"
              type="text"
              value={(node.config?.condition as string) || ""}
              placeholder="output.length > 100"
              onChange={(e) => onConfigChange({ condition: e.target.value })}
            />
          </ConfigField>
          <p className="vsc-cfg-hint">
            JS expression evaluated with <code>output</code> (string) and <code>length</code> (number) in scope.
            Example: <code>output.includes("success")</code>, <code>length &gt; 500</code>.
          </p>
        </>
      )}
    </>
  );
}

function ShellExecConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  return (
    <>
      <ConfigField label="Command">
        <textarea
          className="vsc-cfg-textarea vsc-cfg-textarea--mono"
          rows={3}
          value={(node.config?.command as string) || ""}
          placeholder="npm test"
          onChange={(e) => onConfigChange({ command: e.target.value })}
        />
      </ConfigField>
      <ConfigField label="Working Directory">
        <input
          className="vsc-cfg-select"
          type="text"
          value={(node.config?.workdir as string) || ""}
          placeholder="(defaults to server cwd)"
          onChange={(e) => onConfigChange({ workdir: e.target.value })}
        />
      </ConfigField>
      <div style={{ display: "flex", gap: 8 }}>
        <ConfigField label="Timeout (ms)">
          <input
            className="vsc-cfg-select"
            type="number"
            value={(node.config?.timeout as number) || 30000}
            onChange={(e) => onConfigChange({ timeout: Number(e.target.value) })}
          />
        </ConfigField>
        <ConfigField label="Output Format">
          <select
            className="vsc-cfg-select"
            value={(node.config?.outputFormat as string) || "text"}
            onChange={(e) => onConfigChange({ outputFormat: e.target.value })}
          >
            <option value="text">Text</option>
            <option value="json">JSON</option>
          </select>
        </ConfigField>
      </div>
      <p className="vsc-cfg-hint">
        Output includes stdout, stderr, and exitCode. Use Branch with <code>success</code> or <code>exit:0</code> to route on result.
      </p>
    </>
  );
}

function ContextConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const sourceType = (node.config?.sourceType as string) || "text";

  return (
    <>
      <ConfigField label="Source Type">
        <select
          className="vsc-cfg-select"
          value={sourceType}
          onChange={(e) => onConfigChange({ sourceType: e.target.value })}
        >
          <option value="text">Plain Text</option>
          <option value="search">Web Search</option>
          <option value="url">URL (fetch)</option>
          <option value="file">File Path</option>
        </select>
      </ConfigField>

      {sourceType === "search" && (
        <ConfigField label="Search Query">
          <input
            className="vsc-cfg-select"
            type="text"
            value={(node.config?.searchQuery as string) || ""}
            placeholder="React hooks best practices 2024"
            onChange={(e) => onConfigChange({ searchQuery: e.target.value })}
          />
          <p className="vsc-cfg-hint">Uses Brave Search API (set BRAVE_API_KEY in .env) or DuckDuckGo fallback.</p>
        </ConfigField>
      )}

      {sourceType === "text" && (
        <ConfigField label="Content">
          <textarea
            className="vsc-cfg-textarea"
            rows={5}
            value={(node.config?.content as string) || ""}
            placeholder="Paste context text here…"
            onChange={(e) => onConfigChange({ content: e.target.value })}
          />
        </ConfigField>
      )}
      {sourceType === "url" && (
        <ConfigField label="URL">
          <input
            className="vsc-cfg-select"
            type="text"
            value={(node.config?.url as string) || ""}
            placeholder="https://…"
            onChange={(e) => onConfigChange({ url: e.target.value })}
          />
        </ConfigField>
      )}
      {sourceType === "file" && (
        <ConfigField label="File Path">
          <input
            className="vsc-cfg-select"
            type="text"
            value={(node.config?.filePath as string) || ""}
            placeholder="/path/to/file.md"
            onChange={(e) => onConfigChange({ filePath: e.target.value })}
          />
        </ConfigField>
      )}

      <ConfigField label="Assertion Notes">
        <textarea
          className="vsc-cfg-textarea"
          rows={3}
          value={(node.config?.notes as string) || ""}
          placeholder="What is this context and why does it matter?"
          onChange={(e) => onConfigChange({ notes: e.target.value })}
        />
      </ConfigField>

      <div className="vsc-cfg-field vsc-cfg-field--check">
        <label className="vsc-cfg-check-label">
          <input
            type="checkbox"
            checked={Boolean(node.config?.spreadToChain)}
            onChange={(e) => onConfigChange({ spreadToChain: e.target.checked })}
          />
          Spread to all downstream nodes
        </label>
        <p className="vsc-cfg-hint">
          When on, context is injected into every node reachable from the connected target, not just the first.
        </p>
      </div>
    </>
  );
}

interface SidebarProps {
  workspaceTab: WorkspaceTab;
  sidebarTab: string | null;
  mode: string;
  nodeTypes: NodeTypeConfig[];
  placementTypeId: string;
  pendingConnectionSourceId: string | null;
  selectedNode: BoardNode | null;
  selectedTypeName: string | null;
  selectedLabelDraft: string;
  chainNodes: BoardNode[];
  chainRunning: boolean;
  traceEvents: NodeRunTraceEvent[];
  activeRunId: string | null;
  socketRef: React.MutableRefObject<WebSocket | null>;
  pendingApprovals: Map<string, PendingApproval>;
  onSetMode: (mode: string, typeId?: string) => void;
  onLabelChange: (label: string) => void;
  onDeleteNode: () => void;
  onNodeConfigChange: (nodeId: string, patch: Record<string, unknown>) => void;
  onApprove: () => void;
  onReject: () => void;
  onApproveToolCall: (approvalId: string) => void;
  onDenyToolCall: (approvalId: string) => void;
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="vsc-cfg-field">
      <label className="vsc-cfg-label">{label}</label>
      {children}
    </div>
  );
}

function formatTraceTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function traceKindLabel(kind: string): string {
  return kind
    .replace(/^node:/, "")
    .replace(/^chain:/, "")
    .replace(/^review:/, "review ")
    .replace(/-/g, " ");
}

function traceDataPreview(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  if (typeof data.preview === "string") return data.preview;
  if (typeof data.outputPreview === "string") return data.outputPreview;
  if (typeof data.toolName === "string") return data.toolName;
  if (typeof data.error === "string") return data.error;
  return "";
}

function TraceTimeline({
  events,
  nodes,
  emptyLabel,
}: {
  events: NodeRunTraceEvent[];
  nodes: BoardNode[];
  emptyLabel: string;
}) {
  const nodeLabels = new Map(nodes.map((node) => [node.id, node.label || node.typeId]));
  const visibleEvents = [...events]
    .sort((a, b) => (a.at - b.at) || (a.seq - b.seq))
    .slice(-80);

  if (visibleEvents.length === 0) {
    return <div className="vsc-trace-empty">{emptyLabel}</div>;
  }

  return (
    <div className="vsc-trace-list">
      {visibleEvents.map((event) => {
        const nodeLabel = event.nodeId ? nodeLabels.get(event.nodeId) : null;
        const preview = traceDataPreview(event.data);
        return (
          <div key={event.id} className={`vsc-trace-row vsc-trace-row--${event.level}`}>
            <span className="vsc-trace-time">{formatTraceTime(event.at)}</span>
            <div className="vsc-trace-body">
              <div className="vsc-trace-meta">
                <span className="vsc-trace-kind">{traceKindLabel(event.kind)}</span>
                {nodeLabel && <span className="vsc-trace-node">{nodeLabel}</span>}
              </div>
              <div className="vsc-trace-message">{event.message}</div>
              {preview && <div className="vsc-trace-preview">{preview}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const AGENT_ROLES = [
  { value: "investigate", label: "Investigate" },
  { value: "plan",        label: "Plan" },
  { value: "design",      label: "Design" },
  { value: "create",      label: "Create" },
  { value: "evaluate",    label: "Evaluate" },
  { value: "document",    label: "Document" },
  { value: "test",        label: "Test" },
  { value: "debug",       label: "Debug" },
  { value: "refactor",    label: "Refactor" },
  { value: "deploy",      label: "Deploy" },
];

const AGENT_TOOLS = [
  { value: "web_search", label: "Web Search", description: "Search the public web during this agent step." },
  { value: "fetch_url", label: "Fetch URL", description: "Read text from a specific URL." },
  { value: "read_file", label: "Read File", description: "Read workspace files." },
  { value: "write_file", label: "Write File", description: "Write workspace files directly." },
  { value: "list_files", label: "List Files", description: "Inspect workspace file paths." },
  { value: "shell_exec", label: "Shell Exec", description: "Run shell commands in the workspace." },
];

function AgentConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const role = (node.config?.role as string) || "investigate";
  const provider = (node.config?.provider as string) || "openai";
  const model = (node.config?.model as string) || MODELS[provider]?.[0] || "";
  const taskPrompt =
    (node.config?.taskPrompt as string) ||
    (node.config?.systemPrompt as string) ||
    "";
  const tools = Array.isArray(node.config?.tools)
    ? (node.config.tools as unknown[]).filter((tool): tool is string => typeof tool === "string")
    : ["web_search", "fetch_url"];
  const maxToolCalls = Number(node.config?.maxToolCalls) || 6;

  function toggleTool(tool: string, enabled: boolean) {
    const next = enabled
      ? Array.from(new Set([...tools, tool]))
      : tools.filter((item) => item !== tool);
    onConfigChange({ tools: next });
  }

  return (
    <>
      <ConfigField label="Role">
        <select
          className="vsc-cfg-select"
          value={role}
          onChange={(e) => onConfigChange({ role: e.target.value })}
        >
          {AGENT_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </ConfigField>
      <ConfigField label="Task Prompt">
        <textarea
          className="vsc-cfg-textarea"
          rows={5}
          value={taskPrompt}
          placeholder="What should this step do with the incoming input and context?"
          onChange={(e) => onConfigChange({ taskPrompt: e.target.value, systemPrompt: "" })}
        />
        <p className="vsc-cfg-hint">
          The internal {role} skill stays as the system prompt. This text is sent as the task at hand.
        </p>
      </ConfigField>
      <ConfigField label="Provider">
        <select
          className="vsc-cfg-select"
          value={provider}
          onChange={(e) => onConfigChange({ provider: e.target.value, model: MODELS[e.target.value]?.[0] || "" })}
        >
          {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </ConfigField>
      <ConfigField label="Model">
        <select
          className="vsc-cfg-select"
          value={model}
          onChange={(e) => onConfigChange({ model: e.target.value })}
        >
          {(MODELS[provider] || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </ConfigField>
      <ConfigField label="Live Tools">
        <div className="vsc-cfg-checkgrid">
          {AGENT_TOOLS.map((tool) => (
            <label key={tool.value} className="vsc-cfg-check-label" title={tool.description}>
              <input
                type="checkbox"
                checked={tools.includes(tool.value)}
                onChange={(e) => toggleTool(tool.value, e.target.checked)}
              />
              {tool.label}
            </label>
          ))}
        </div>
        <p className="vsc-cfg-hint">
          The agent can call enabled tools while this node runs. File and shell tools are constrained to the workspace.
        </p>
      </ConfigField>
      <ConfigField label="Max Tool Calls">
        <input
          className="vsc-cfg-select"
          type="number"
          min={0}
          max={20}
          value={maxToolCalls}
          onChange={(e) => onConfigChange({ maxToolCalls: Number(e.target.value) })}
        />
      </ConfigField>
    </>
  );
}

function MemoryConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const operation = (node.config?.operation as string) || "read";
  const key = (node.config?.key as string) || "";

  return (
    <>
      <ConfigField label="Operation">
        <select
          className="vsc-cfg-select"
          value={operation}
          onChange={(e) => onConfigChange({ operation: e.target.value })}
        >
          <option value="write">Write — store input into memory</option>
          <option value="read">Read — output stored value</option>
        </select>
      </ConfigField>
      <ConfigField label="Key">
        <input
          className="vsc-cfg-select"
          type="text"
          value={key}
          placeholder="e.g. initial-output"
          onChange={(e) => onConfigChange({ key: e.target.value })}
        />
      </ConfigField>
      <p className="vsc-cfg-hint">
        {operation === "write"
          ? "Stores this node's input in memory under the key. Chain continues with same value."
          : "Reads the stored value for this key and outputs it into the chain."}
      </p>
    </>
  );
}

function StartConfig({
  node, onConfigChange,
}: { node: BoardNode; onConfigChange: (patch: Record<string, unknown>) => void }) {
  const provider = (node.config?.defaultProvider as string) || "openai";
  const model = (node.config?.defaultModel as string) || MODELS[provider]?.[0] || "";

  return (
    <>
      <ConfigField label="Task Description">
        <textarea
          className="vsc-cfg-textarea"
          rows={4}
          value={(node.config?.taskDescription as string) || ""}
          placeholder="Describe the overall goal…"
          onChange={(e) => onConfigChange({ taskDescription: e.target.value })}
        />
      </ConfigField>
      <ConfigField label="Default Provider">
        <select
          className="vsc-cfg-select"
          value={provider}
          onChange={(e) => onConfigChange({ defaultProvider: e.target.value, defaultModel: MODELS[e.target.value]?.[0] || "" })}
        >
          {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </ConfigField>
      <ConfigField label="Default Model">
        <select
          className="vsc-cfg-select"
          value={model}
          onChange={(e) => onConfigChange({ defaultModel: e.target.value })}
        >
          {(MODELS[provider] || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </ConfigField>
    </>
  );
}

type SidebarContentTab = "config" | "trace" | "chat";

export function Sidebar({
  workspaceTab,
  sidebarTab,
  mode,
  nodeTypes,
  placementTypeId,
  selectedNode,
  selectedTypeName,
  selectedLabelDraft,
  chainNodes,
  chainRunning,
  traceEvents,
  activeRunId,
  socketRef,
  pendingApprovals,
  onSetMode,
  onLabelChange,
  onDeleteNode,
  onNodeConfigChange,
  onApprove,
  onReject,
  onApproveToolCall,
  onDenyToolCall,
}: SidebarProps) {
  const [contentTab, setContentTab] = useState<SidebarContentTab>("config");

  // Auto-switch to Trace tab when chain starts running
  useEffect(() => {
    if (chainRunning) {
      setContentTab("trace");
    }
  }, [chainRunning]);

  // Find pending approvals for the selected node
  const selectedNodeApprovals = selectedNode
    ? Array.from(pendingApprovals.entries()).filter(([, a]) => a.nodeId === selectedNode.id)
    : [];

  const hasChainActivity = chainNodes.some((n) => n.status !== "idle");
  const sortedChainNodes = [...chainNodes].sort((a, b) => {
    const order: Record<string, number> = { running: 0, paused: 1, done: 2, error: 3, idle: 4 };
    return (order[a.status ?? "idle"] ?? 4) - (order[b.status ?? "idle"] ?? 4);
  });

  const chainSteps = nodeTypes.filter((t) => t.category === "start" || t.category === "ai-step");
  const controlNodes = nodeTypes.filter((t) => t.category === "review" || t.category === "control");
  const utilityNodes = nodeTypes.filter((t) => t.category === "tool" || t.category === "memory");
  const contextNodes = nodeTypes.filter((t) => t.category === "context");

  function handleConfigChange(patch: Record<string, unknown>) {
    if (selectedNode) onNodeConfigChange(selectedNode.id, patch);
  }

  const selectedNodeType = selectedNode ? nodeTypes.find((t) => t.id === selectedNode.typeId) : null;
  const selectedTraceEvents = selectedNode
    ? traceEvents.filter((event) => event.nodeId === selectedNode.id).slice(-24)
    : [];

  const isChat = contentTab === "chat" && sidebarTab === "toolbox";

  return (
    <aside className={`vsc-sidebar${isChat ? " vsc-sidebar--chat" : ""}`} aria-label="Sidebar">
      {sidebarTab === "toolbox" && workspaceTab === "plan" && (
        <div className="vsc-sidebar-title">Plan Workspace</div>
      )}

      {sidebarTab === "toolbox" && workspaceTab === "canvas" && (
        <>
          {/* Tab strip */}
          <div className="sidebar-tabs" role="tablist" aria-label="Sidebar content">
            <button
              type="button"
              role="tab"
              aria-selected={contentTab === "config"}
              className={`sidebar-tab${contentTab === "config" ? " active" : ""}`}
              onClick={() => setContentTab("config")}
            >
              Config
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={contentTab === "trace"}
              className={`sidebar-tab${contentTab === "trace" ? " active" : ""}`}
              onClick={() => setContentTab("trace")}
            >
              Trace
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={contentTab === "chat"}
              className={`sidebar-tab${contentTab === "chat" ? " active" : ""}`}
              onClick={() => setContentTab("chat")}
            >
              Chat
            </button>
          </div>

          {/* Config tab */}
          {contentTab === "config" && (
            <>
              {/* Mode buttons */}
              <div className="vsc-section-hdr">Modes</div>
              <div className="vsc-list">
                <button
                  type="button"
                  className={`vsc-list-item${mode === "select" ? " active" : ""}`}
                  onClick={() => onSetMode("select")}
                >
                  <span className="vsc-list-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M1.5 1L7 13.5l2.2-5.3L14.5 6z"/>
                    </svg>
                  </span>
                  <span className="vsc-list-label">Pointer</span>
                  <kbd className="vsc-kbd">V</kbd>
                </button>
                <button
                  type="button"
                  className={`vsc-list-item${mode === "connect" ? " active" : ""}`}
                  onClick={() => onSetMode("connect")}
                >
                  <span className="vsc-list-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <circle cx="3.5" cy="8" r="2.2"/>
                      <circle cx="12.5" cy="8" r="2.2"/>
                      <line x1="5.7" y1="8" x2="10.3" y2="8"/>
                      <polyline points="9,6.6 10.6,8 9,9.4" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <span className="vsc-list-label">Connect</span>
                  <kbd className="vsc-kbd">C</kbd>
                </button>
              </div>

              {/* Chain steps */}
              <div className="vsc-section-hdr">Chain Steps</div>
              <div className="vsc-list">
                {chainSteps.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`vsc-list-item${mode === "place" && placementTypeId === t.id ? " active" : ""}`}
                    onClick={() => onSetMode("place", t.id)}
                  >
                    <span
                      className="vsc-glyph shape-rect"
                      style={{ borderColor: t.accent, background: `${t.accent}22` }}
                      aria-hidden="true"
                    />
                    <span className="vsc-list-label">{t.label}</span>
                  </button>
                ))}
              </div>

              {/* Control nodes */}
              <div className="vsc-section-hdr">Control</div>
              <div className="vsc-list">
                {controlNodes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`vsc-list-item${mode === "place" && placementTypeId === t.id ? " active" : ""}`}
                    onClick={() => onSetMode("place", t.id)}
                  >
                    <span
                      className="vsc-glyph shape-rect"
                      style={{ borderColor: t.accent, background: `${t.accent}22` }}
                      aria-hidden="true"
                    />
                    <span className="vsc-list-label">{t.label}</span>
                  </button>
                ))}
              </div>

              {/* Utility nodes */}
              <div className="vsc-section-hdr">Utilities</div>
              <div className="vsc-list">
                {utilityNodes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`vsc-list-item${mode === "place" && placementTypeId === t.id ? " active" : ""}`}
                    onClick={() => onSetMode("place", t.id)}
                  >
                    <span
                      className="vsc-glyph shape-rect"
                      style={{ borderColor: t.accent, background: `${t.accent}22` }}
                      aria-hidden="true"
                    />
                    <span className="vsc-list-label">{t.label}</span>
                  </button>
                ))}
              </div>

              {/* Context nodes */}
              {contextNodes.length > 0 && (
                <>
                  <div className="vsc-section-hdr">Context</div>
                  <div className="vsc-list">
                    {contextNodes.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`vsc-list-item${mode === "place" && placementTypeId === t.id ? " active" : ""}`}
                        onClick={() => onSetMode("place", t.id)}
                      >
                        <span
                          className="vsc-glyph shape-rect"
                          style={{ borderColor: t.accent, background: `${t.accent}22` }}
                          aria-hidden="true"
                        />
                        <span className="vsc-list-label">{t.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Properties panel when node selected */}
              {selectedNode && selectedNodeType && (
                <>
                  <div className="vsc-divider" />
                  <div className="vsc-section-hdr">Properties</div>

                  {/* Label */}
                  <div className="vsc-props">
                    <div className="vsc-prop-row">
                      <span className="vsc-prop-key">Label</span>
                      <input
                        className="vsc-prop-input"
                        type="text"
                        value={selectedLabelDraft}
                        onChange={(e) => onLabelChange(e.target.value.slice(0, 80))}
                      />
                    </div>
                    <div className="vsc-prop-row">
                      <span className="vsc-prop-key">Type</span>
                      <span className="vsc-prop-val" style={{ color: selectedNodeType.accent }}>
                        {selectedTypeName}
                      </span>
                    </div>
                    <div className="vsc-prop-row">
                      <span className="vsc-prop-key">Status</span>
                      <span className="vsc-prop-val">{selectedNode.status ?? "idle"}</span>
                    </div>
                  </div>

                  {/* Type-specific config */}
                  <div className="vsc-cfg-panel">
                    {selectedNodeType.id === "agent" && (
                      <AgentConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.category === "start" && (
                      <StartConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.id === "branch" && (
                      <BranchConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.id === "file-write" && (
                      <FileWriteConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.id === "shell-exec" && (
                      <ShellExecConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.id === "memory" && (
                      <MemoryConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.category === "context" && (
                      <ContextConfig node={selectedNode} onConfigChange={handleConfigChange} />
                    )}
                    {selectedNodeType.category === "review" && selectedNode.status === "paused" && (
                      <div className="vsc-review-panel">
                        <p className="vsc-review-msg">⏸ Chain paused — awaiting your review</p>
                        <div className="vsc-review-actions">
                          <button type="button" className="vsc-review-approve" onClick={onApprove}>✓ Approve</button>
                          <button type="button" className="vsc-review-reject" onClick={onReject}>✕ Reject</button>
                        </div>
                      </div>
                    )}
                    {selectedNodeApprovals.length > 0 && (
                      <div className="vsc-review-panel">
                        {selectedNodeApprovals.map(([approvalId, approval]) => (
                          <div key={approvalId} className="vsc-approval-entry">
                            <p className="vsc-review-msg" style={{ color: "#b45309" }}>
                              Tool approval required: <strong>{approval.toolName}</strong>
                            </p>
                            {Object.keys(approval.args).length > 0 && (
                              <pre className="vsc-output-text" style={{ fontSize: 10, maxHeight: 80, overflow: "auto", marginBottom: 6 }}>
                                {JSON.stringify(approval.args, null, 2)}
                              </pre>
                            )}
                            <div className="vsc-review-actions">
                              <button type="button" className="vsc-review-approve" onClick={() => onApproveToolCall(approvalId)}>✓ Allow</button>
                              <button type="button" className="vsc-review-reject" onClick={() => onDenyToolCall(approvalId)}>✕ Deny</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Output preview */}
                  {selectedNode.output && (
                    <>
                      <div className="vsc-divider" />
                      <div className="vsc-section-hdr">Output</div>
                      <div className="vsc-output-preview">
                        <pre className="vsc-output-text">{selectedNode.output}</pre>
                      </div>
                    </>
                  )}

                  {/* Delete */}
                  <div className="vsc-divider" />
                  <button type="button" className="vsc-prop-delete" onClick={onDeleteNode}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <polyline points="3,4 13,4"/>
                      <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/>
                      <path d="M4 4l1 9h6l1-9"/>
                    </svg>
                    Delete node
                  </button>
                </>
              )}
            </>
          )}

          {/* Trace tab */}
          {contentTab === "trace" && (
            <>
              <div className="vsc-run-summary">
                <span>{chainRunning ? "Running" : activeRunId ? "Active" : traceEvents.length > 0 ? "Last run" : "No runs yet"}</span>
                <span>{traceEvents.length} events</span>
              </div>
              <TraceTimeline
                events={traceEvents}
                nodes={chainNodes}
                emptyLabel="Run the canvas to see model and tool activity."
              />
              {(chainRunning || hasChainActivity) && (
                <>
                  <div className="vsc-divider" />
                  <div className="vsc-section-hdr">Node Status</div>
                  <div className="vsc-chain-progress">
                    {sortedChainNodes.map((node) => {
                      const s = (node.status ?? "idle") as NodeStatus;
                      const nt = nodeTypes.find((t) => t.id === node.typeId);
                      return (
                        <div key={node.id} className={`vsc-chain-row vsc-chain-row--${s}`}>
                          <span className="vsc-chain-status-icon" style={{ color: STATUS_COLOR[s] }}>
                            {STATUS_ICON[s]}
                          </span>
                          <span className="vsc-chain-node-dot" style={{ background: nt?.accent ?? "#a0a0a0" }} />
                          <span className="vsc-chain-node-label">{node.label || nt?.label || node.typeId}</span>
                          {s === "running" && <span className="vsc-chain-running-badge">running</span>}
                          {s === "done" && node.output && (
                            <span className="vsc-chain-done-badge">done</span>
                          )}
                          {s === "error" && <span className="vsc-chain-error-badge">error</span>}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {selectedNode && selectedTraceEvents.length > 0 && (
                <>
                  <div className="vsc-divider" />
                  <div className="vsc-section-hdr">Selected Node Trace</div>
                  <TraceTimeline
                    events={selectedTraceEvents}
                    nodes={chainNodes}
                    emptyLabel="No trace events for this node yet."
                  />
                </>
              )}
            </>
          )}

          {/* Chat tab */}
          {contentTab === "chat" && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <ChatPanel socketRef={socketRef} nodeTypes={nodeTypes} workspaceTab={workspaceTab} />
            </div>
          )}
        </>
      )}

      {sidebarTab === "chat" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <ChatPanel socketRef={socketRef} nodeTypes={nodeTypes} workspaceTab={workspaceTab} />
        </div>
      )}
    </aside>
  );
}
