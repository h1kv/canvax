import { useEffect, useRef, useState } from "react";
import type { ChatGraphOperation, ChatMessage, ChatTranscriptMessage, WorkspaceTab } from "../../types/index.js";

interface ChatPanelProps {
  socketRef: React.MutableRefObject<WebSocket | null>;
  workspaceTab: WorkspaceTab;
  selectedNodeId: string | null;
  initialMessages: ChatTranscriptMessage[];
  hydrationVersion: number;
  hidden?: boolean;
  onPendingOpsChange: (operations: ChatGraphOperation[] | null) => void;
}

function sendJson(ws: WebSocket | null, msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function CommandBadge({ command, nodeId, onExecute }: { command: string; nodeId?: string | null; onExecute: () => void }) {
  const label = command === "run_chain" ? "Run chain" : command === "stop_chain" ? "Stop chain" : "Retry from node";
  return (
    <div className="vsc-chat-cmd-card">
      <span className="vsc-chat-cmd-label">{label}</span>
      <button type="button" className="vsc-chat-cmd-btn" onClick={onExecute}>Execute</button>
    </div>
  );
}

function OpCard({ summary, ops, onApply, onDeny }: { summary: string; ops: ChatGraphOperation[]; onApply: () => void; onDeny: () => void }) {
  return (
    <div className="vsc-chat-ops-card">
      <div className="vsc-chat-ops-summary">{summary}</div>
      <div className="vsc-chat-ops-count">{ops.length} operation{ops.length !== 1 ? "s" : ""}</div>
      <div className="vsc-chat-ops-actions">
        <button type="button" className="vsc-chat-ops-apply" onClick={onApply}>Apply</button>
        <button type="button" className="vsc-chat-ops-deny" onClick={onDeny}>Dismiss</button>
      </div>
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.5 8L2.5 2.5l2.5 5.5-2.5 5.5L13.5 8z" fill="currentColor" />
    </svg>
  );
}

function DispatchIcon() {
  return (
    <span className="vsc-chat-ai-avatar" aria-hidden="true">D</span>
  );
}

export function ChatPanel({
  socketRef,
  workspaceTab,
  selectedNodeId,
  initialMessages,
  hydrationVersion,
  hidden = false,
  onPendingOpsChange,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingOpsIndexRef = useRef<number | null>(null);

  useEffect(() => {
    pendingOpsIndexRef.current = null;
    onPendingOpsChange(null);
    setMessages(initialMessages.map((msg) => ({ role: msg.role, content: msg.content })));
    setLoading(false);
    setStreaming(false);
    setStreamText("");
  }, [hydrationVersion]);

  useEffect(() => {
    function onChatEvent(e: Event) {
      const msg = (e as CustomEvent<Record<string, unknown>>).detail;

      if (msg.type === "chat:chunk") {
        setLoading(false);
        setStreaming(true);
        setStreamText((prev) => prev + (msg.text as string));
        return;
      }

      if (msg.type === "chat:done") {
        setStreaming(false);
        setLoading(false);
        const finalText = (msg.text as string) || "";
        const pendingOps = msg.pendingOps as ChatGraphOperation[] | undefined;
        const pendingSummary = msg.pendingSummary as string | undefined;
        const error = msg.error as string | undefined;
        const command = msg.command as string | undefined;
        const commandNodeId = msg.commandNodeId as string | null | undefined;

        setStreamText("");
        setMessages((prev) => {
          const newMsg: ChatMessage = { role: "assistant", content: finalText, pendingOps, pendingSummary, error, command, commandNodeId };
          const next = [...prev, newMsg];
          if (pendingOps) pendingOpsIndexRef.current = next.length - 1;
          return next;
        });
        if (pendingOps) onPendingOpsChange(pendingOps);
        if (error && !pendingOps) onPendingOpsChange(null);
        return;
      }

      if (msg.type === "chat:applied") {
        const idx = pendingOpsIndexRef.current;
        if (idx !== null) {
          setMessages((prev) => {
            if (idx >= prev.length) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], pendingOps: undefined };
            return next;
          });
          pendingOpsIndexRef.current = null;
        }
        onPendingOpsChange(null);
        return;
      }

      if (msg.type === "chat:error") {
        setLoading(false);
        setStreaming(false);
        setStreamText("");
        setMessages((prev) => [...prev, { role: "assistant", content: "", error: (msg.message as string) || "Chat error." }]);
        onPendingOpsChange(null);
        return;
      }
    }

    window.addEventListener("dispatch:chat", onChatEvent);
    return () => window.removeEventListener("dispatch:chat", onChatEvent);
  }, [onPendingOpsChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamText, loading]);

  function autoResize() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  function send() {
    const content = input.trim();
    if (!content || loading || streaming) return;
    pendingOpsIndexRef.current = null;
    onPendingOpsChange(null);
    setMessages((prev) => [...prev, { role: "user", content }]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setLoading(true);
    setStreamText("");
    sendJson(socketRef.current, { type: "chat:message", content, workspaceTab, selectedNodeId });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function handleApply(ops: ChatGraphOperation[]) {
    sendJson(socketRef.current, { type: "chat:apply", operations: ops });
  }

  function handleDeny() {
    const idx = pendingOpsIndexRef.current;
    if (idx !== null) {
      setMessages((prev) => {
        if (idx >= prev.length) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], pendingOps: undefined };
        return next;
      });
      pendingOpsIndexRef.current = null;
      onPendingOpsChange(null);
    }
  }

  function executeCommand(command: string, nodeId?: string | null) {
    if (command === "run_chain") sendJson(socketRef.current, { type: "chain:run" });
    else if (command === "stop_chain") sendJson(socketRef.current, { type: "chain:stop" });
    else if (command === "retry_from_node" && nodeId) sendJson(socketRef.current, { type: "chain:retry", fromNodeId: nodeId });
  }

  const canSend = input.trim().length > 0 && !loading && !streaming;

  return (
    <div className="vsc-chat-panel" aria-hidden={hidden} style={{ display: hidden ? "none" : undefined }}>
      <div className="vsc-chat-history" ref={scrollRef}>
        {messages.length === 0 && !loading && !streaming && (
          <div className="vsc-chat-empty">
            <div className="vsc-chat-empty-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z" />
                <path d="M8 12h8M12 8v8" />
              </svg>
            </div>
            <p className="vsc-chat-empty-title">Workflow Copilot</p>
            <p className="vsc-chat-empty-sub">Build, debug, and run chains through natural language.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`vsc-chat-row vsc-chat-row--${msg.role}`}>
            {msg.role === "assistant" ? (
              <>
                <div className="vsc-chat-row-header">
                  <DispatchIcon />
                  <span className="vsc-chat-role-label">Dispatch</span>
                </div>
                <div className="vsc-chat-row-body">
                  {msg.content && <p className="vsc-chat-text">{msg.content}</p>}
                  {msg.error && <div className="vsc-chat-error-inline">{msg.error}</div>}
                  {msg.pendingOps && msg.pendingSummary && (
                    <OpCard summary={msg.pendingSummary} ops={msg.pendingOps} onApply={() => handleApply(msg.pendingOps!)} onDeny={handleDeny} />
                  )}
                  {msg.command && (
                    <CommandBadge command={msg.command} nodeId={msg.commandNodeId} onExecute={() => executeCommand(msg.command!, msg.commandNodeId)} />
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="vsc-chat-row-header vsc-chat-row-header--user">
                  <span className="vsc-chat-role-label vsc-chat-role-label--user">You</span>
                </div>
                <div className="vsc-chat-row-body vsc-chat-row-body--user">
                  <p className="vsc-chat-text">{msg.content}</p>
                </div>
              </>
            )}
          </div>
        ))}

        {streaming && streamText && (
          <div className="vsc-chat-row vsc-chat-row--assistant">
            <div className="vsc-chat-row-header">
              <DispatchIcon />
              <span className="vsc-chat-role-label">Dispatch</span>
            </div>
            <div className="vsc-chat-row-body">
              <p className="vsc-chat-text vsc-chat-text--streaming">{streamText}</p>
            </div>
          </div>
        )}

        {loading && !streaming && (
          <div className="vsc-chat-row vsc-chat-row--assistant">
            <div className="vsc-chat-row-header">
              <DispatchIcon />
              <span className="vsc-chat-role-label">Dispatch</span>
            </div>
            <div className="vsc-chat-row-body">
              <div className="vsc-chat-thinking" aria-label="Assistant is responding">
                <span className="vsc-chat-dot" />
                <span className="vsc-chat-dot" />
                <span className="vsc-chat-dot" />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="vsc-chat-input-wrap">
        <div className="vsc-chat-input-box">
          <textarea
            ref={textareaRef}
            className="vsc-chat-input"
            value={input}
            rows={1}
            placeholder={selectedNodeId ? "Ask about this node…" : "Message Dispatch…"}
            onChange={(e) => { setInput(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className={`vsc-chat-send${canSend ? " vsc-chat-send--active" : ""}`}
            onClick={send}
            disabled={!canSend}
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        </div>
        <p className="vsc-chat-input-hint">Enter to send · Shift+Enter for newline</p>
      </div>
    </div>
  );
}
