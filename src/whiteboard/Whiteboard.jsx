import { useCallback, useEffect, useRef, useState } from "react";
import { clamp, createId, distance, findStrokeAtPoint, screenToWorld } from "./geometry.js";
import { renderBoard } from "./render.js";

const palette = [
  { label: "Black", value: "#1f1f1f" },
  { label: "Red", value: "#8a2f2f" },
  { label: "Green", value: "#3f6b4b" },
  { label: "Amber", value: "#8a6a24" },
  { label: "Violet", value: "#6b4f8a" }
];
const minSize = 2;
const maxSize = 12;
const defaultSize = 6;

function getSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function getCanvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function getPointerPair(pointers) {
  const values = Array.from(pointers.values());
  return values.length >= 2 ? [values[0], values[1]] : null;
}

function getMidpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}

function sendJson(socket, message) {
  if (socket.current?.readyState === WebSocket.OPEN) {
    socket.current.send(JSON.stringify(message));
  }
}

export function Whiteboard({ username }) {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);
  const rafRef = useRef(null);
  const strokesRef = useRef(new Map());
  const usersRef = useRef(new Map());
  const selfIdRef = useRef(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const pointersRef = useRef(new Map());
  const activeStrokeRef = useRef(null);
  const activeEraserRef = useRef(null);
  const pendingTouchRef = useRef(null);
  const pinchRef = useRef(null);
  const panRef = useRef(null);
  const lastCursorSentRef = useRef(0);
  const toolRef = useRef("pen");
  const colorRef = useRef(palette[0].value);
  const sizeRef = useRef(defaultSize);

  const [status, setStatus] = useState("connecting");
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(palette[0].value);
  const [size, setSize] = useState(defaultSize);
  const [users, setUsers] = useState(new Map());

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  const requestRender = useCallback(() => {
    if (rafRef.current) return;

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");

      if (canvas && ctx) {
        renderBoard(ctx, canvas, viewRef.current, strokesRef.current, usersRef.current, selfIdRef.current);
      }
    });
  }, []);

  const updateUsers = useCallback(
    (updater) => {
      setUsers((current) => {
        const next = new Map(current);
        updater(next);
        usersRef.current = next;
        return next;
      });
      requestRender();
    },
    [requestRender]
  );

  const updateCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    requestRender();
  }, [requestRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const resizeObserver = new ResizeObserver(updateCanvasSize);
    resizeObserver.observe(canvas);
    updateCanvasSize();

    return () => resizeObserver.disconnect();
  }, [updateCanvasSize]);

  useEffect(() => {
    const socket = new WebSocket(getSocketUrl());
    socketRef.current = socket;
    setStatus("connecting");

    socket.addEventListener("open", () => {
      setStatus("connected");
      sendJson(socketRef, { type: "join", name: username });
    });

    socket.addEventListener("message", (event) => {
      let message;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "init") {
        selfIdRef.current = message.selfId;
        strokesRef.current = new Map((message.strokes || []).map((stroke) => [stroke.id, stroke]));
        const nextUsers = new Map((message.users || []).map((user) => [user.id, user]));
        usersRef.current = nextUsers;
        setUsers(nextUsers);
        requestRender();
        return;
      }

      if (message.type === "user:joined") {
        updateUsers((next) => next.set(message.user.id, message.user));
        return;
      }

      if (message.type === "user:left") {
        updateUsers((next) => next.delete(message.userId));
        return;
      }

      if (message.type === "cursor:update") {
        updateUsers((next) => {
          const user = next.get(message.userId);
          if (user) {
            next.set(message.userId, { ...user, cursor: message.point });
          }
        });
        return;
      }

      if (message.type === "stroke:start") {
        strokesRef.current.set(message.stroke.id, message.stroke);
        requestRender();
        return;
      }

      if (message.type === "stroke:point") {
        const stroke = strokesRef.current.get(message.strokeId);
        if (stroke) {
          stroke.points.push(message.point);
          requestRender();
        }
        return;
      }

      if (message.type === "stroke:erase") {
        for (const strokeId of message.strokeIds || []) {
          strokesRef.current.delete(strokeId);
        }
        requestRender();
        return;
      }

      if (message.type === "stroke:undo") {
        strokesRef.current.delete(message.strokeId);
        requestRender();
      }
    });

    socket.addEventListener("close", () => {
      setStatus("disconnected");
    });

    socket.addEventListener("error", () => {
      setStatus("disconnected");
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [requestRender, updateUsers, username]);

  useEffect(() => {
    function handleKeyDown(event) {
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;

      if (!isUndo || activeStrokeRef.current) return;

      event.preventDefault();
      sendJson(socketRef, { type: "stroke:undo" });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function sendCursor(point) {
    const now = performance.now();
    if (now - lastCursorSentRef.current < 40) return;

    lastCursorSentRef.current = now;
    sendJson(socketRef, { type: "cursor:update", point });
  }

  function startStroke(screenPoint, pointerId) {
    const point = screenToWorld(screenPoint, viewRef.current);
    const stroke = {
      id: createId("stroke"),
      userId: selfIdRef.current,
      userName: username,
      color: colorRef.current,
      size: sizeRef.current,
      points: [point],
      createdAt: Date.now()
    };

    activeStrokeRef.current = { id: stroke.id, pointerId };
    strokesRef.current.set(stroke.id, stroke);
    sendJson(socketRef, {
      type: "stroke:start",
      stroke: {
        id: stroke.id,
        color: stroke.color,
        size: stroke.size,
        point
      }
    });
    sendCursor(point);
    requestRender();
  }

  function appendStroke(screenPoint) {
    const activeStroke = activeStrokeRef.current;
    if (!activeStroke) return;

    const stroke = strokesRef.current.get(activeStroke.id);
    if (!stroke) return;

    const point = screenToWorld(screenPoint, viewRef.current);
    const lastPoint = stroke.points[stroke.points.length - 1];
    if (lastPoint && distance(lastPoint, point) < 1.2) return;

    stroke.points.push(point);
    sendJson(socketRef, { type: "stroke:point", strokeId: stroke.id, point });
    sendCursor(point);
    requestRender();
  }

  function endStroke(pointerId) {
    const activeStroke = activeStrokeRef.current;
    if (!activeStroke || activeStroke.pointerId !== pointerId) return;

    sendJson(socketRef, { type: "stroke:end", strokeId: activeStroke.id });
    activeStrokeRef.current = null;
  }

  function eraseAt(screenPoint) {
    const point = screenToWorld(screenPoint, viewRef.current);
    const strokeId = findStrokeAtPoint(strokesRef.current, point, 8 / viewRef.current.scale);

    if (strokeId) {
      strokesRef.current.delete(strokeId);
      sendJson(socketRef, { type: "stroke:erase", strokeIds: [strokeId] });
      requestRender();
    }

    sendCursor(point);
  }

  function cancelPendingTouch() {
    if (pendingTouchRef.current) {
      window.clearTimeout(pendingTouchRef.current.timer);
      pendingTouchRef.current = null;
    }
  }

  function scheduleTouchDraw(pointerId, screenPoint) {
    cancelPendingTouch();
    pendingTouchRef.current = {
      pointerId,
      screenPoint,
      timer: window.setTimeout(() => {
        const pending = pendingTouchRef.current;
        if (!pending || pointersRef.current.size !== 1) return;

        pendingTouchRef.current = null;
        if (toolRef.current === "eraser") {
          activeEraserRef.current = { pointerId: pending.pointerId };
          eraseAt(pending.screenPoint);
        } else {
          startStroke(pending.screenPoint, pending.pointerId);
        }
      }, 85)
    };
  }

  function beginPinch() {
    const pair = getPointerPair(pointersRef.current);
    if (!pair) return;

    const [first, second] = pair;
    const midpoint = getMidpoint(first, second);
    pinchRef.current = {
      distance: Math.max(distance(first, second), 1),
      midpoint,
      view: { ...viewRef.current },
      worldMidpoint: screenToWorld(midpoint, viewRef.current)
    };
  }

  function updatePinch() {
    const pair = getPointerPair(pointersRef.current);
    const pinch = pinchRef.current;
    if (!pair || !pinch) return;

    const [first, second] = pair;
    const midpoint = getMidpoint(first, second);
    const nextScale = clamp((pinch.view.scale * distance(first, second)) / pinch.distance, 0.25, 4);

    viewRef.current = {
      x: midpoint.x - pinch.worldMidpoint.x * nextScale,
      y: midpoint.y - pinch.worldMidpoint.y * nextScale,
      scale: nextScale
    };
    requestRender();
  }

  function handlePointerDown(event) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const screenPoint = getCanvasPoint(canvas, event);
    pointersRef.current.set(event.pointerId, screenPoint);
    sendCursor(screenToWorld(screenPoint, viewRef.current));

    if (event.pointerType === "mouse" && (event.button === 1 || event.button === 2 || event.altKey)) {
      panRef.current = {
        pointerId: event.pointerId,
        lastPoint: screenPoint
      };
      return;
    }

    if (pointersRef.current.size >= 2) {
      cancelPendingTouch();
      activeStrokeRef.current = null;
      activeEraserRef.current = null;
      beginPinch();
      return;
    }

    if (event.pointerType === "touch") {
      scheduleTouchDraw(event.pointerId, screenPoint);
      return;
    }

    if (toolRef.current === "eraser") {
      activeEraserRef.current = { pointerId: event.pointerId };
      eraseAt(screenPoint);
    } else {
      startStroke(screenPoint, event.pointerId);
    }
  }

  function handlePointerMove(event) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const screenPoint = getCanvasPoint(canvas, event);

    if (!pointersRef.current.has(event.pointerId)) {
      if (event.pointerType === "mouse") {
        sendCursor(screenToWorld(screenPoint, viewRef.current));
      }
      return;
    }

    event.preventDefault();
    pointersRef.current.set(event.pointerId, screenPoint);

    if (pendingTouchRef.current?.pointerId === event.pointerId) {
      pendingTouchRef.current.screenPoint = screenPoint;
    }

    if (panRef.current?.pointerId === event.pointerId) {
      const lastPoint = panRef.current.lastPoint;
      viewRef.current = {
        ...viewRef.current,
        x: viewRef.current.x + screenPoint.x - lastPoint.x,
        y: viewRef.current.y + screenPoint.y - lastPoint.y
      };
      panRef.current.lastPoint = screenPoint;
      requestRender();
      return;
    }

    if (pinchRef.current && pointersRef.current.size >= 2) {
      updatePinch();
      return;
    }

    if (activeStrokeRef.current?.pointerId === event.pointerId) {
      appendStroke(screenPoint);
      return;
    }

    if (activeEraserRef.current?.pointerId === event.pointerId) {
      eraseAt(screenPoint);
      return;
    }

    sendCursor(screenToWorld(screenPoint, viewRef.current));
  }

  function handlePointerUp(event) {
    cancelPendingTouch();
    endStroke(event.pointerId);

    if (activeEraserRef.current?.pointerId === event.pointerId) {
      activeEraserRef.current = null;
    }

    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
    }

    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
    }
  }

  function handleWheel(event) {
    event.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const screenPoint = getCanvasPoint(canvas, event);

    if (event.ctrlKey || event.metaKey) {
      const worldPoint = screenToWorld(screenPoint, viewRef.current);
      const zoomDelta = Math.exp(-event.deltaY * 0.002);
      const nextScale = clamp(viewRef.current.scale * zoomDelta, 0.25, 4);

      viewRef.current = {
        x: screenPoint.x - worldPoint.x * nextScale,
        y: screenPoint.y - worldPoint.y * nextScale,
        scale: nextScale
      };
    } else {
      viewRef.current = {
        ...viewRef.current,
        x: viewRef.current.x - event.deltaX,
        y: viewRef.current.y - event.deltaY
      };
    }

    requestRender();
  }

  const connectedUsers = Array.from(users.values());

  return (
    <main className="board-shell">
      <header className="board-header">
        <div className="board-brand">canvax.ai</div>
        <section className="presence-panel" aria-label="Connection status">
          <span className={`connection ${status}`}>{status}</span>
          <span>{connectedUsers.length} online</span>
        </section>
      </header>

      <section className="board-content">
        <section className="board-main">
          <canvas
            ref={canvasRef}
            className="board-canvas"
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
          />

          <section className="toolbar" aria-label="Whiteboard tools">
            <div className="tool-group" aria-label="Drawing tools">
              <button
                className={tool === "pen" ? "tool-button active" : "tool-button"}
                type="button"
                onClick={() => setTool("pen")}
              >
                Pen
              </button>
              <button
                className={tool === "eraser" ? "tool-button active" : "tool-button"}
                type="button"
                onClick={() => setTool("eraser")}
              >
                Eraser
              </button>
            </div>

            <div className="tool-group color-group" aria-label="Pen colors">
              {palette.map((item) => (
                <button
                  key={item.value}
                  className={color === item.value ? "color-button active" : "color-button"}
                  type="button"
                  aria-label={item.label}
                  title={item.label}
                  style={{ "--swatch": item.value }}
                  onClick={() => {
                    setColor(item.value);
                    setTool("pen");
                  }}
                />
              ))}
            </div>

            <div className="tool-group slider-group" aria-label="Pen thickness">
              <input
                className="size-slider"
                type="range"
                min={minSize}
                max={maxSize}
                step="1"
                value={size}
                aria-label="Pen thickness"
                onChange={(event) => {
                  setSize(Number(event.target.value));
                  setTool("pen");
                }}
              />
            </div>
          </section>
        </section>

        <aside className="board-sidebar" aria-label="Session controls">
          <button className="connect-button" type="button">
            Connect
          </button>
        </aside>
      </section>
    </main>
  );
}
