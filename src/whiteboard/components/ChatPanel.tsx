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
  const label = command === "run_chain" ? "Run chain" : command === "stop_chain" ? "Stop chain" : `Retry from node`;
  return (
    <div className="vsc-chat-cmd-card">
      <span className="vsc-chat-cmd-label">{label}</span>
      <button type="button" className="vsc-chat-cmd-btn" onClick={onExecute}>
        Execute
      </button>
    </div>
  );
}

function OpCard({
  summary,
  ops,
  onApply,
  onDeny,
}: {
  summary: string;
  ops: ChatGraphOperation[];
  onApply: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="vsc-chat-ops-card">
      <div className="vsc-chat-ops-summary">{summary}</div>
      <div className="vsc-chat-ops-count">{ops.length} operation{ops.length !== 1 ? "s" : ""}</div>
      <div className="vsc-chat-ops-actions">
        <button type="button" className="vsc-chat-ops-apply" onClick={onApply}>
          Apply
        </button>
        <button type="button" className="vsc-chat-ops-deny" onClick={onDeny}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ErrorInline({ message }: { message: string }) {
  return <div className="vsc-chat-error-inline">{message}</div>;
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

  // Track which message index holds pending ops (always the last assistant message)
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
          const newMsg: ChatMessage = {
            role: "assistant",
            content: finalText,
            pendingOps,
            pendingSummary,
            error,
            command,
            commandNodeId,
          };
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
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "", error: (msg.message as string) || "Chat error." },
        ]);
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

  function send() {
    const content = input.trim();
    if (!content || loading || streaming) return;
    // Clear any pending ops card on new message
    pendingOpsIndexRef.current = null;
    onPendingOpsChange(null);
    setMessages((prev) => [...prev, { role: "user", content }]);
    setInput("");
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

  return (
    <div className="vsc-chat-panel" aria-hidden={hidden} style={{ display: hidden ? "none" : undefined }}>
      <div className="vsc-chat-history" ref={scrollRef}>
        {messages.length === 0 && !loading && !streaming && (
          <div className="vsc-chat-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" />
            </svg>
            <p>Workflow copilot</p>
            <p className="sub">Build, debug, and run chains through natural language.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`vsc-chat-msg vsc-chat-msg--${msg.role}`}>
            {msg.role === "assistant" ? (
              <div className="vsc-chat-assistant-group">
                {msg.content && (
                  <div className="vsc-chat-bubble vsc-chat-bubble--assistant">
                    <p className="vsc-chat-text">{msg.content}</p>
                  </div>
                )}
                {msg.error && <ErrorInline message={msg.error} />}
                {msg.pendingOps && msg.pendingSummary && (
                  <OpCard
                    summary={msg.pendingSummary}
                    ops={msg.pendingOps}
                    onApply={() => handleApply(msg.pendingOps!)}
                    onDeny={handleDeny}
                  />
                )}
                {msg.command && (
                  <CommandBadge
                    command={msg.command}
                    nodeId={msg.commandNodeId}
                    onExecute={() => executeCommand(msg.command!, msg.commandNodeId)}
                  />
                )}
              </div>
            ) : (
              <div className="vsc-chat-bubble vsc-chat-bubble--user">
                <p className="vsc-chat-text">{msg.content}</p>
              </div>
            )}
          </div>
        ))}

        {/* Live streaming bubble */}
        {streaming && streamText && (
          <div className="vsc-chat-msg vsc-chat-msg--assistant">
            <div className="vsc-chat-bubble vsc-chat-bubble--assistant vsc-chat-bubble--streaming">
              <p className="vsc-chat-text">{streamText}</p>
            </div>
          </div>
        )}

        {loading && !streaming && (
          <div className="vsc-chat-msg vsc-chat-msg--assistant">
            <div className="vsc-chat-bubble vsc-chat-bubble--loading" aria-label="Assistant is responding">
              <span className="vsc-chat-dot" />
              <span className="vsc-chat-dot" />
              <span className="vsc-chat-dot" />
            </div>
          </div>
        )}
      </div>

      <div className="vsc-chat-input-wrap">
        <textarea
          className="vsc-chat-input"
          value={input}
          rows={2}
          placeholder={selectedNodeId ? "Ask about this node or the workflow…" : "Build a pipeline, debug a failure, explain the graph…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
