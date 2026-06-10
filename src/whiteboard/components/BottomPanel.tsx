import { useEffect, useRef, useState } from "react";
import type { MaterializeWritePlan, NodeV2, ReviewRequest } from "../../types/index.js";
import type { TerminalEntry } from "../hooks/useSocket.js";

interface BottomPanelProps {
  logs: TerminalEntry[];
  open: boolean;
  height: number;
  onClose: () => void;
  onClear: () => void;
  selectedNode: NodeV2 | null;
  nodeErrors: Map<string, string>;
  materializePlan: MaterializeWritePlan | null;
  reviewRequest: ReviewRequest | null;
  nodesMap: React.MutableRefObject<Map<string, NodeV2>>;
  onSelectNode: (nodeId: string) => void;
  onReviewRespond: (reviewId: string, action: "approve" | "reject" | "request-changes", notes?: string) => void;
  chainRunning: boolean;
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

function actionIcon(action: string): string {
  switch (action) {
    case "create": return "+";
    case "modify": return "~";
    case "skip":   return "=";
    default:       return "?";
  }
}

export function BottomPanel({
  logs,
  open,
  height,
  onClose,
  onClear,
  selectedNode,
  nodeErrors,
  materializePlan,
  reviewRequest,
  nodesMap,
  onSelectNode,
  onReviewRespond,
  chainRunning,
}: BottomPanelProps) {
  const [activeTab, setActiveTab] = useState<"terminal" | "problems" | "output" | "files" | "review">("terminal");
  const [requestChangesNotes, setRequestChangesNotes] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal to bottom on new logs
  useEffect(() => {
    if (open && activeTab === "terminal" && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open, activeTab]);

  // Auto-switch to review tab when review is pending
  useEffect(() => {
    if (reviewRequest) setActiveTab("review");
  }, [reviewRequest?.reviewId]);

  // Auto-switch to files tab when plan arrives
  useEffect(() => {
    if (materializePlan && materializePlan.files.length > 0) setActiveTab("files");
  }, [materializePlan]);

  const problemCount = nodeErrors.size;
  const hasOutput = Boolean(selectedNode?.output);
  const hasFiles = Boolean(materializePlan && materializePlan.files.length > 0);
  const hasReview = Boolean(reviewRequest);

  function TabBtn({ id, label, badge }: { id: typeof activeTab; label: string; badge?: number }) {
    return (
      <button
        type="button"
        className={`vsc-bp-tab${activeTab === id ? " vsc-bp-tab--active" : ""}`}
        onClick={() => setActiveTab(id)}
      >
        {label}
        {badge != null && badge > 0 && (
          <span className="vsc-bp-badge">{badge}</span>
        )}
      </button>
    );
  }

  return (
    <div
      className={`vsc-bp-wrap${open ? "" : " vsc-bp--closed"}`}
      style={{ height: open ? height : 0 }}
    >
      {/* Tab bar */}
      <div className="vsc-bp-bar">
        <div className="vsc-bp-tabs">
          <TabBtn id="terminal" label="Terminal" />
          <TabBtn id="problems" label="Problems" badge={problemCount} />
          <TabBtn id="output" label="Output" />
          <TabBtn id="files" label="Files" badge={hasFiles ? materializePlan!.files.length : undefined} />
          {hasReview && <TabBtn id="review" label="Review ●" />}
        </div>
        <div className="vsc-bp-actions">
          {activeTab === "terminal" && (
            <button type="button" className="vsc-bp-act" onClick={onClear} title="Clear terminal">
              Clear
            </button>
          )}
          <button type="button" className="vsc-bp-act" onClick={onClose} title="Close panel" aria-label="Close">
            ×
          </button>
        </div>
      </div>

      {/* Terminal tab */}
      {activeTab === "terminal" && (
        <div className="vsc-bp-body" ref={bodyRef}>
          {logs.length === 0 ? (
            <span className="vsc-bp-empty">No output yet. Run a chain to see logs.</span>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className={`vsc-terminal-line vsc-terminal-line--${entry.level}`}>
                <span className="vsc-terminal-ts">{formatTs(entry.ts)}</span>
                <span className="vsc-terminal-msg">{levelPrefix(entry.level)} {entry.msg}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Problems tab */}
      {activeTab === "problems" && (
        <div className="vsc-bp-body">
          {problemCount === 0 ? (
            <span className="vsc-bp-empty">No problems detected.</span>
          ) : (
            Array.from(nodeErrors.entries()).map(([nodeId, errMsg]) => {
              const node = nodesMap.current.get(nodeId);
              return (
                <button
                  key={nodeId}
                  type="button"
                  className="vsc-bp-problem"
                  onClick={() => onSelectNode(nodeId)}
                >
                  <span className="vsc-bp-problem-icon">✕</span>
                  <span className="vsc-bp-problem-title">{node?.title ?? nodeId}</span>
                  <span className="vsc-bp-problem-msg">{errMsg}</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Output tab */}
      {activeTab === "output" && (
        <div className="vsc-bp-body vsc-bp-body--output">
          {!selectedNode ? (
            <span className="vsc-bp-empty">Select a node to see its output.</span>
          ) : !hasOutput ? (
            <span className="vsc-bp-empty">
              {selectedNode.status === "running" ? "Running…" : `${selectedNode.title} has no output yet.`}
            </span>
          ) : (
            <>
              <div className="vsc-bp-output-hdr">
                <span className="vsc-bp-output-title">{selectedNode.title}</span>
                <button
                  type="button"
                  className="vsc-bp-act"
                  onClick={() => navigator.clipboard?.writeText(selectedNode.output ?? "")}
                >
                  Copy
                </button>
              </div>
              <pre className="vsc-bp-output-body">{selectedNode.output}</pre>
            </>
          )}
        </div>
      )}

      {/* Files tab */}
      {activeTab === "files" && (
        <div className="vsc-bp-body">
          {!materializePlan ? (
            <span className="vsc-bp-empty">No Materialize plan yet.</span>
          ) : (
            <>
              {materializePlan.errors.length > 0 && (
                <div className="vsc-bp-plan-errors">
                  {materializePlan.errors.map((e, i) => (
                    <div key={i} className="vsc-bp-plan-error">✕ {e}</div>
                  ))}
                </div>
              )}
              {materializePlan.files.map((file) => (
                <div key={file.relativePath} className={`vsc-bp-file vsc-bp-file--${file.action}`}>
                  <span className="vsc-bp-file-icon">{actionIcon(file.action)}</span>
                  <span className="vsc-bp-file-path">{file.relativePath}</span>
                  <span className="vsc-bp-file-meta">{file.bytes} bytes</span>
                  {file.warnings.length > 0 && (
                    <span className="vsc-bp-file-warn" title={file.warnings.join("; ")}>⚠</span>
                  )}
                  {file.diff && (
                    <details className="vsc-bp-diff">
                      <summary>diff</summary>
                      <pre className="vsc-bp-diff-body">{file.diff}</pre>
                    </details>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Review tab */}
      {activeTab === "review" && (
        <div className="vsc-bp-body vsc-bp-body--review">
          {!reviewRequest ? (
            <span className="vsc-bp-empty">No review pending.</span>
          ) : (
            <>
              <div className="vsc-bp-review-hdr">
                <span className="vsc-bp-review-title">Review checkpoint: {reviewRequest.title}</span>
                <span className={`vsc-bp-review-status${chainRunning ? " vsc-bp-review-status--waiting" : ""}`}>
                  {chainRunning ? "Waiting…" : "Done"}
                </span>
              </div>
              <pre className="vsc-bp-review-content">{reviewRequest.content.slice(0, 3000)}</pre>
              {reviewRequest.content.length > 3000 && (
                <p className="vsc-bp-empty">… content truncated ({reviewRequest.content.length} chars total)</p>
              )}
              <div className="vsc-bp-review-actions">
                <button
                  type="button"
                  className="vsc-bp-review-btn vsc-bp-review-btn--approve"
                  onClick={() => { onReviewRespond(reviewRequest.reviewId, "approve"); setRequestChangesNotes(""); }}
                  disabled={!chainRunning}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="vsc-bp-review-btn vsc-bp-review-btn--reject"
                  onClick={() => { onReviewRespond(reviewRequest.reviewId, "reject"); setRequestChangesNotes(""); }}
                  disabled={!chainRunning}
                >
                  Reject
                </button>
                <div className="vsc-bp-review-changes">
                  <textarea
                    className="vsc-field-textarea"
                    value={requestChangesNotes}
                    onChange={(e) => setRequestChangesNotes(e.target.value)}
                    placeholder="Notes for downstream nodes…"
                    rows={2}
                    disabled={!chainRunning}
                  />
                  <button
                    type="button"
                    className="vsc-bp-review-btn vsc-bp-review-btn--changes"
                    onClick={() => { onReviewRespond(reviewRequest.reviewId, "request-changes", requestChangesNotes); setRequestChangesNotes(""); }}
                    disabled={!chainRunning || !requestChangesNotes.trim()}
                  >
                    Request changes
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
