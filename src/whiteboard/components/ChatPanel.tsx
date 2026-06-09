import { useState, useEffect, useRef } from "react";
import type { NodeTypeConfig, WorkspaceTab } from "../../types/index.js";

type ChatMode = "auto" | "plan" | "accept";
type ResponseMode = "done" | "questions" | "preview";

interface CanvasOp {
  op: string;
  tmpId?: string;
  typeId?: string;
  label?: string;
  nodeId?: string;
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
  sourcePort?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

interface PlanOp {
  op: string;
  tmpId?: string;
  kind?: string;
  title?: string;
  body?: string;
  nodeId?: string;
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
  label?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  responseMode?: ResponseMode;
  questions?: string[];
  operations?: CanvasOp[];
  planOperations?: PlanOp[];
  requestContent?: string;
  applied?: boolean;
}

interface ChatPanelProps {
  socketRef: React.MutableRefObject<WebSocket | null>; // used only for sending
  nodeTypes: NodeTypeConfig[];
  workspaceTab: WorkspaceTab;
}

function sendJson(ws: WebSocket | null, msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function ChatPanel({ socketRef, nodeTypes, workspaceTab }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("auto");
  const [loading, setLoading] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingRequestRef = useRef<string | null>(null);

  useEffect(() => {
    function onChatEvent(e: Event) {
      const msg = (e as CustomEvent<Record<string, unknown>>).detail;

      if (msg.type === "chat:response") {
        setLoading(false);
        setMessages(prev => [...prev, {
          role: "assistant",
          content: (msg.response as string) ?? "",
          responseMode: (msg.responseMode as ResponseMode) ?? "done",
          questions: msg.questions as string[] | undefined,
          operations: msg.operations as CanvasOp[] | undefined,
          planOperations: msg.planOperations as PlanOp[] | undefined,
          requestContent: msg.questions ? pendingRequestRef.current ?? undefined : undefined,
        }]);
        if (msg.questions) {
          setAnswers(new Array((msg.questions as string[]).length).fill(""));
        } else {
          setPendingRequest(null);
          pendingRequestRef.current = null;
        }
      }

      if (msg.type === "chat:error") {
        setLoading(false);
        setPendingRequest(null);
        pendingRequestRef.current = null;
        setMessages(prev => [...prev, {
          role: "assistant",
          content: `⚠ ${msg.message as string}`,
          responseMode: "done",
        }]);
      }
    }

    window.addEventListener("dispatch:chat", onChatEvent);
    return () => window.removeEventListener("dispatch:chat", onChatEvent);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  function send(content: string, answersPayload?: string[]) {
    if (!content.trim() || loading) return;
    if (!answersPayload) {
      setMessages(prev => [...prev, { role: "user", content }]);
    }
    setInput("");
    setLoading(true);
    setPendingRequest(content);
    pendingRequestRef.current = content;
    sendJson(socketRef.current, {
      type: "chat:message",
      content,
      mode,
      workspaceTab,
      answers: answersPayload ?? null,
    });
  }

  function submitAnswers(questions: string[], requestContent = pendingRequest) {
    if (!requestContent) return;
    const answersText = questions.map((q, i) => `${q}: ${answers[i] || "(skipped)"}`).join("\n");
    setMessages(prev => [...prev, { role: "user", content: answersText }]);
    setLoading(true);
    sendJson(socketRef.current, {
      type: "chat:message",
      content: requestContent,
      mode: "plan",
      workspaceTab,
      answers,
    });
    setAnswers([]);
    setPendingRequest(null);
    pendingRequestRef.current = null;
  }

  function applyOps(ops: CanvasOp[], planOps: PlanOp[], msgIndex: number) {
    sendJson(socketRef.current, { type: "chat:apply", operations: ops, planOperations: planOps });
    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, applied: true, operations: undefined, planOperations: undefined } : m));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function opSummary(op: CanvasOp): string {
    const typeName = nodeTypes.find(t => t.id === op.typeId)?.label ?? op.typeId ?? "";
    if (op.op === "create_node") return `Add ${typeName} node`;
    if (op.op === "update_node") return `Update node`;
    if (op.op === "delete_node") return `Delete node`;
    if (op.op === "create_edge") return `Connect nodes`;
    if (op.op === "delete_edge") return `Remove connection`;
    return op.op;
  }

  function planOpSummary(op: PlanOp): string {
    if (op.op === "create_plan_node") return `Add ${op.kind ?? "plan"} block`;
    if (op.op === "update_plan_node") return `Update plan block`;
    if (op.op === "delete_plan_node") return `Delete plan block`;
    if (op.op === "create_plan_edge") return `Connect plan blocks`;
    if (op.op === "delete_plan_edge") return `Remove plan connection`;
    return op.op;
  }

  return (
    <div className="vsc-chat-panel">
      {/* Mode tabs */}
      <div className="vsc-chat-modes">
        {(["auto", "plan", "accept"] as ChatMode[]).map(m => (
          <button
            key={m}
            type="button"
            className={`vsc-chat-mode-btn${mode === m ? " active" : ""}`}
            onClick={() => setMode(m)}
            title={
              m === "auto" ? "Apply changes immediately" :
              m === "plan" ? "AI asks questions first" :
              "Preview changes before applying"
            }
          >
            {m === "auto" ? "Auto" : m === "plan" ? "Plan" : "Review"}
          </button>
        ))}
      </div>

      {/* Message history */}
      <div className="vsc-chat-history" ref={scrollRef}>
        {messages.length === 0 && !loading && (
          <div className="vsc-chat-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
              <path d="M12 8v4M12 16h.01"/>
            </svg>
            <p>Workspace assistant</p>
            <p className="sub">Ask me to plan workflows, sketch the Plan board, build executable chains, or explain your workspace.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`vsc-chat-msg vsc-chat-msg--${msg.role}`}>
            <div className="vsc-chat-bubble">
              {msg.content && <p className="vsc-chat-text">{msg.content}</p>}

              {/* Plan mode: question inputs */}
              {msg.questions && !msg.applied && (
                <div className="vsc-chat-questions">
                  {msg.questions.map((q, qi) => (
                    <div key={qi} className="vsc-chat-q">
                      <label className="vsc-chat-q-label">{q}</label>
                      <input
                        className="vsc-chat-q-input"
                        type="text"
                        value={answers[qi] ?? ""}
                        placeholder="Answer…"
                        onChange={e => setAnswers(prev => { const a = [...prev]; a[qi] = e.target.value; return a; })}
                        onKeyDown={e => { if (e.key === "Enter" && qi === msg.questions!.length - 1) submitAnswers(msg.questions!, msg.requestContent); }}
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    className="vsc-chat-submit-btn"
                    onClick={() => submitAnswers(msg.questions!, msg.requestContent)}
                    disabled={loading}
                  >
                    Submit answers →
                  </button>
                </div>
              )}

              {/* Accept mode: operation preview */}
              {((msg.operations && msg.operations.length > 0) || (msg.planOperations && msg.planOperations.length > 0)) && !msg.applied && (
                <div className="vsc-chat-ops">
                  <div className="vsc-chat-ops-list">
                    {(msg.operations ?? []).map((op, oi) => (
                      <div key={oi} className="vsc-chat-op-row">
                        <span className={`vsc-chat-op-chip vsc-chat-op-chip--${op.op.split("_")[0]}`}>
                          {op.op === "create_node" ? "+" : op.op === "delete_node" || op.op === "delete_edge" ? "−" : "~"}
                        </span>
                        <span className="vsc-chat-op-text">{opSummary(op)}</span>
                      </div>
                    ))}
                    {(msg.planOperations ?? []).map((op, oi) => (
                      <div key={`plan-${oi}`} className="vsc-chat-op-row">
                        <span className="vsc-chat-op-chip vsc-chat-op-chip--plan">
                          {op.op === "create_plan_node" ? "+" : op.op === "delete_plan_node" || op.op === "delete_plan_edge" ? "−" : "~"}
                        </span>
                        <span className="vsc-chat-op-text">{planOpSummary(op)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="vsc-chat-ops-btns">
                    <button type="button" className="vsc-chat-apply-btn" onClick={() => applyOps(msg.operations ?? [], msg.planOperations ?? [], i)}>
                      Apply {(msg.operations?.length ?? 0) + (msg.planOperations?.length ?? 0)} change{((msg.operations?.length ?? 0) + (msg.planOperations?.length ?? 0)) !== 1 ? "s" : ""}
                    </button>
                    <button type="button" className="vsc-chat-dismiss-btn" onClick={() => setMessages(prev => prev.map((m, idx) => idx === i ? { ...m, operations: undefined, planOperations: undefined } : m))}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="vsc-chat-msg vsc-chat-msg--assistant">
            <div className="vsc-chat-bubble vsc-chat-bubble--loading">
              <span className="vsc-chat-dot" />
              <span className="vsc-chat-dot" />
              <span className="vsc-chat-dot" />
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="vsc-chat-input-wrap">
        <textarea
          ref={inputRef}
          className="vsc-chat-input"
          rows={2}
          value={input}
          placeholder={
            mode === "plan" ? "Describe what you want to build… (Enter to send)" :
            "Ask the canvas assistant… (Enter to send)"
          }
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
